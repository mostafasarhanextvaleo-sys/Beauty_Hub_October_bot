const { getSession, updateSession, STAGES } = require('./conversationMemory');
const escalationDetector = require('./escalationDetector');
const { buildEscalationResponse, baseLogFields, resolveEarlyStageOrderStatus } = require('./sessionLogHelpers');
const deliveryFeedbackDetector = require('./deliveryFeedbackDetector');
const productSearch = require('./productSearch');
const localService = require('../services/localService');
const geminiService = require('../services/geminiService');
const openaiService = require('../services/openaiService');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('./llmSystemPrompt');
const { MESSAGES } = require('./prompts');
const config = require('../config');
const logger = require('../utils/logger');
const trainingDataLogger = require('../utils/trainingDataLogger');
const agentStats = require('./agentStats');
const routineBundles = require('./routineBundles');
const googleSheets = require('../services/googleSheets');

// Rolling window, not the full conversation — bounds prompt size/cost. ~10
// user/model turn pairs is enough for the model to track context and avoid
// re-asking things without re-sending the whole conversation every call.
const MAX_HISTORY_TURNS = 20;

// A conversation counts as a fresh "episode" once the session has sat idle
// this long — used to gate the returning-customer feedback ask so it can
// only fire on the first message of a new episode, not every turn of an
// hours-long live conversation (session.updatedAt refreshes every message,
// so this naturally stops re-triggering after the first hit).
const NEW_EPISODE_GAP_MS = 6 * 60 * 60 * 1000; // 6 hours
// Only ask for feedback on a past order once it's had a few days to actually
// be used — asking the day after purchase reads as impatient, not caring.
const RETURNING_CUSTOMER_FEEDBACK_GAP_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// customerProfile passed into buildSystemPrompt(): { history, askFeedback }
// from googleSheets.getCustomerHistory(phone) (a pure in-memory Map lookup,
// safe to call every message — see googleSheets.js), or null for a brand-new
// customer. askFeedback only true on the first message of a fresh episode
// (previousUpdatedAt, captured BEFORE this turn touches the session) whose
// most recent completed order is old enough to plausibly have an opinion on.
function buildCustomerProfile(phone, previousUpdatedAt) {
  const history = googleSheets.getCustomerHistory(phone);
  if (history.length === 0) return null;

  const isNewEpisode = !previousUpdatedAt || Date.now() - previousUpdatedAt > NEW_EPISODE_GAP_MS;
  const lastOrder = history[0];
  const askFeedback = isNewEpisode && Date.now() - lastOrder.timestamp > RETURNING_CUSTOMER_FEEDBACK_GAP_MS;

  return { history, askFeedback };
}

// Hard backstop against infinite loops, independent of what the model says —
// mirrors the legacy rule engine's MAX_UNCLEAR_CONFIRMATION_ATTEMPTS pattern.
const MAX_NO_PROGRESS_TURNS = 3;

function pushHistory(history, role, text) {
  return [...history, { role, parts: [{ text }] }].slice(-MAX_HISTORY_TURNS);
}

// A phone number's shape (digit-heavy, fixed rough length) is distinctive
// enough to capture safely with a plain regex even with no LLM available at
// all — unlike a name or address, which could be almost any text and would
// risk being misfiled into the wrong field if guessed blindly. Deliberately
// narrow: only fires while already mid-order-collection and only for the
// phone field, so a stray digit-only message elsewhere in the conversation
// isn't misread as an order's alt phone.
const PHONE_LIKE = /^[\d\s+()-]{8,15}$/;

function recoverOrderDataOnFailure(session, text) {
  const orderData = session.orderData || {};
  const missingAltPhone = session.stage === STAGES.AWAIT_ORDER_DETAILS && !orderData.altPhone;
  if (missingAltPhone && PHONE_LIKE.test(text)) {
    return { ...orderData, altPhone: text.trim() };
  }
  return orderData;
}

// Nullable schema fields (price_quoted, order_data.*) are sometimes filled by
// the model with the literal text "null" instead of actually omitting the
// value (observed in practice from the OpenAI fallback) — treat that as
// absent everywhere, not just where it happens to get caught. Left
// unnormalized, the literal word "null" could otherwise be stored as if it
// were a real customer name/address/phone.
function nullableString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

function sanitizeModelOutput(output) {
  if (!output) return output;
  return {
    ...output,
    price_quoted: nullableString(output.price_quoted),
    routine_bundle_suggested_id: nullableString(output.routine_bundle_suggested_id),
    routine_bundle_price_quoted: nullableString(output.routine_bundle_price_quoted),
    order_data: {
      ...output.order_data,
      customer_name: nullableString(output.order_data?.customer_name),
      delivery_address: nullableString(output.order_data?.delivery_address),
      alt_phone: nullableString(output.order_data?.alt_phone),
    },
  };
}

// Arabic diacritics vary across model outputs and product-catalog entries for
// what is otherwise the same word — strip them (plus collapse whitespace) so
// a name comparison isn't defeated by a stray fatha/kasra either side didn't
// happen to include.
function normalizeArabicText(text) {
  return text
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Catalog names carry a parenthetical English translation
// ("... 100 مل (Disaar Vitamin C ... 100ml)") that the model never reproduces
// in Arabic prose — compare against the Arabic portion only.
function productNameAppearsInReply(product, replyText) {
  const arabicName = normalizeArabicText(product.name.split('(')[0]);
  if (!arabicName) return false;
  return normalizeArabicText(replyText).includes(arabicName);
}

// A turn's candidates come from keyword-searching THAT turn's raw text alone
// (see productSearch.searchProducts) — a message like "تمام، احجزيلي الأوردر"
// (order confirmation, no product name repeated) matches nothing and returns
// zero candidates. The model still needs to reference the item actually being
// ordered, so the currently-recommended product is always folded back in
// regardless of whether this turn's text happens to search-match it — without
// this, order-confirmation turns get validated-rejected for referencing "a
// product outside this turn's candidate list" when that product is exactly
// the one from a prior turn the model (correctly) still has in mind.
function selectCandidatesForTurn(text, { excludeIds = [], recommendedProduct = null } = {}) {
  const candidates = productSearch.searchProducts(text, { excludeIds });
  if (recommendedProduct && !candidates.some((p) => p.id === recommendedProduct.id)) {
    return [recommendedProduct, ...candidates];
  }
  return candidates;
}

// Every mentioned product id must come from THIS turn's candidate list (never
// the full catalog) — rejecting the whole reply otherwise is safer than
// guessing what to strip out of an already-written sentence. price_quoted is
// checked digit-for-digit against a mentioned candidate's real price rather
// than scanning reply_text for any number, which would false-positive on
// legitimate non-price digits (product sizes, SPF ratings, etc).
function validateModelOutput(output, candidates, bundleComplement = null) {
  if (!output || typeof output.reply_text !== 'string' || !output.reply_text.trim()) return null;

  const candidateIds = new Set(candidates.map((p) => p.id));
  const rawMentionedIds = Array.isArray(output.mentioned_product_ids) ? output.mentioned_product_ids : [];
  if (!rawMentionedIds.every((id) => candidateIds.has(id))) {
    logger.warn(`LLM agent referenced product id(s) outside this turn's candidate list: ${rawMentionedIds.join(', ')}`);
    return null;
  }

  // Observed in production: the model sometimes tags a candidate as
  // "mentioned" that it never actually named in reply_text (e.g. wrote out a
  // 9-item list but tagged a 10th, unlisted candidate). mentioned_product_ids
  // is what drives the Product Name written to the Leads sheet, so only trust
  // ids the customer actually saw named in the reply — drop the rest rather
  // than rejecting an otherwise-good reply outright.
  const mentionedIds = rawMentionedIds.filter((id) => {
    const product = candidates.find((p) => p.id === id);
    return product && productNameAppearsInReply(product, output.reply_text);
  });
  if (mentionedIds.length !== rawMentionedIds.length) {
    const dropped = rawMentionedIds.filter((id) => !mentionedIds.includes(id));
    logger.warn(`LLM agent tagged product id(s) as mentioned that don't appear in its reply text: ${dropped.join(', ')}`);
  }

  if (output.price_quoted) {
    const quotedDigits = output.price_quoted.replace(/\D/g, '');
    // No digits at all (e.g. the model echoed placeholder text like "غير محدد
    // بعد" instead of leaving the field empty) isn't a fabricated price claim
    // — there's nothing numeric to have invented, so don't punish an
    // otherwise-honest reply for it. Only reject when there ARE digits that
    // don't match any mentioned candidate's real price — that's the actual
    // hallucination risk this check exists for.
    if (quotedDigits) {
      // Verify against rawMentionedIds (candidate-set membership only), NOT
      // the prose-filtered mentionedIds above — a short reply like "السعر 195
      // جنيه" can correctly state a candidate's real price without repeating
      // that candidate's full (often long, SKU-suffixed) name verbatim, and
      // checking against the narrower list was rejecting genuinely correct
      // prices whenever that happened.
      const mentioned = candidates.filter((p) => rawMentionedIds.includes(p.id));
      const verified = mentioned.some((p) => String(p.price || '').replace(/\D/g, '') === quotedDigits);
      if (!verified) {
        logger.warn(`LLM agent quoted an unverified price "${output.price_quoted}" — discarding reply.`);
        return null;
      }
    }
  }

  // Routine-bundle fields are validated the same way as price_quoted, but a
  // failure here only drops the bundle suggestion rather than discarding the
  // whole reply — it's an upsell add-on, not core order-processing
  // correctness, so being defensive (silently drop) beats being strict
  // (reject a perfectly good reply just because the bonus upsell was off).
  let routineBundleSuggestedId = output.routine_bundle_suggested_id || null;
  let routineBundlePriceQuoted = output.routine_bundle_price_quoted || null;

  if (routineBundleSuggestedId) {
    if (!bundleComplement || routineBundleSuggestedId !== bundleComplement.id) {
      logger.warn(
        `LLM agent suggested a routine bundle id "${routineBundleSuggestedId}" that wasn't offered this turn — dropping the bundle suggestion, keeping the rest of the reply.`
      );
      routineBundleSuggestedId = null;
      routineBundlePriceQuoted = null;
    } else if (routineBundlePriceQuoted) {
      const quotedDigits = routineBundlePriceQuoted.replace(/\D/g, '');
      const verified = !quotedDigits || String(bundleComplement.price || '').replace(/\D/g, '') === quotedDigits;
      if (!verified) {
        logger.warn(
          `LLM agent quoted an unverified routine-bundle price "${routineBundlePriceQuoted}" for ${bundleComplement.id} — dropping the bundle suggestion, keeping the rest of the reply.`
        );
        routineBundleSuggestedId = null;
        routineBundlePriceQuoted = null;
      }
    }
  } else {
    routineBundlePriceQuoted = null;
  }

  return {
    ...output,
    mentioned_product_ids: mentionedIds,
    routine_bundle_suggested_id: routineBundleSuggestedId,
    routine_bundle_price_quoted: routineBundlePriceQuoted,
  };
}

// Code, never the model, decides order completion and human handover — both
// are re-derived here from validated fields rather than trusted as asserted.
function applyValidatedOutput(session, output, candidates) {
  const prevOrder = session.orderData || {};
  const orderData = {
    customerName: output.order_data.customer_name || prevOrder.customerName || null,
    deliveryAddress: output.order_data.delivery_address || prevOrder.deliveryAddress || null,
    altPhone: output.order_data.alt_phone || prevOrder.altPhone || null,
  };

  const fieldsBefore = [prevOrder.customerName, prevOrder.deliveryAddress, prevOrder.altPhone].filter(Boolean).length;
  const fieldsAfter = [orderData.customerName, orderData.deliveryAddress, orderData.altPhone].filter(Boolean).length;
  const madeProgress = fieldsAfter > fieldsBefore;
  const orderCollectionActive = fieldsAfter > 0 || output.intent === 'ORDER_INTENT';

  const noProgressTurns = orderCollectionActive && !madeProgress ? (session.noProgressTurns || 0) + 1 : 0;

  const allFieldsPresent = Boolean(orderData.customerName && orderData.deliveryAddress && orderData.altPhone);
  const orderConfirmed = allFieldsPresent && output.order_data.confirmed === true;

  const humanHandover = output.human_handover === true || noProgressTurns >= MAX_NO_PROGRESS_TURNS;

  let recommendedProduct = session.recommendedProduct || null;
  let shownProductIds = session.shownProductIds || [];
  const mentionedIds = Array.isArray(output.mentioned_product_ids) ? output.mentioned_product_ids : [];
  if (mentionedIds.length > 0) {
    const primary = candidates.find((p) => p.id === mentionedIds[0]);
    if (primary) recommendedProduct = primary;
    shownProductIds = [...new Set([...shownProductIds, ...mentionedIds])];
  }

  // Deterministic coarse mapping onto the existing STAGES enum — purely so
  // cartRecovery.js/chatLogger keep working unchanged regardless of agent mode.
  let stage;
  if (humanHandover || orderConfirmed) stage = STAGES.CLOSED;
  else if (allFieldsPresent) stage = STAGES.AWAIT_ORDER_CONFIRMATION;
  else if (orderCollectionActive) stage = STAGES.AWAIT_ORDER_DETAILS;
  else if (recommendedProduct) stage = STAGES.RECOMMENDED;
  else stage = STAGES.AWAIT_CATEGORY;

  return { orderData, orderConfirmed, humanHandover, stage, recommendedProduct, shownProductIds, noProgressTurns };
}

function buildLogEntryAndNotification(session, phone, text, output, applied) {
  const baseFields = baseLogFields(session, phone, text);

  if (applied.orderConfirmed) {
    // Recovery attribution: cartRecovery.js sets nudgeSentAt/secondNudgeSentAt
    // on this same session object, but never touches the Sheet itself — this
    // is the one place that later learns an order actually closed, so it's
    // the right place to note whether a nudge preceded it. Without this,
    // "did our cart-recovery nudges make money" has no answer anywhere.
    // The second nudge promises real free shipping (see cartRecovery.js) —
    // flagged explicitly and loudly here, not just "a nudge happened", since
    // someone actually has to waive the delivery fee for this specific order
    // at fulfillment for that promise to be true.
    const recoveryNote = session.secondNudgeSentAt
      ? ' (بعد تذكير السلة المتروكة الثاني — 🚚 وعدنا العميل بتوصيل مجاني، لازم نلتزم بيه!)'
      : session.nudgeSentAt
      ? ' (بعد تذكير السلة المتروكة)'
      : '';
    const adminNotification =
      `✅ طلب جديد مكتمل! (وكيل ذكي)\n` +
      `المنتج: ${applied.recommendedProduct ? applied.recommendedProduct.name : 'غير محدد'}\n` +
      `الاسم: ${applied.orderData.customerName || 'غير محدد'}\n` +
      `رقم العميل: ${phone}\n` +
      `رقم بديل: ${applied.orderData.altPhone || 'غير محدد'}\n` +
      `العنوان: ${applied.orderData.deliveryAddress || 'غير محدد'}${recoveryNote}`;
    // Order History (separate append-only sheet — see googleSheets.js) is
    // what powers the "returning customer" memory feature: unlike the Leads
    // row (upserted per-phone, so it only ever reflects the CURRENT order),
    // this is one row per completed order, so a customer's full purchase
    // history is actually recoverable later.
    const orderHistoryEntry = {
      date: new Date().toISOString(),
      customerName: applied.orderData.customerName || baseFields.customerName,
      phone,
      productName: applied.recommendedProduct ? applied.recommendedProduct.name : baseFields.productName,
      price: applied.recommendedProduct ? applied.recommendedProduct.price : '',
      orderStatus: 'Completed',
    };
    return {
      logEntry: {
        ...baseFields,
        productName: applied.recommendedProduct ? applied.recommendedProduct.name : baseFields.productName,
        customerName: applied.orderData.customerName || baseFields.customerName,
        deliveryAddress: applied.orderData.deliveryAddress || baseFields.deliveryAddress,
        orderStatus: 'Completed',
        notes: `تم تأكيد الطلب عبر الوكيل الذكي (محلي/OpenAI/Gemini)${recoveryNote}`,
      },
      adminNotification,
      orderHistoryEntry,
    };
  }

  if (applied.humanHandover) {
    const adminNotification =
      `🆘 الوكيل الذكي حوّل المحادثة لفريق بشري\n` +
      `رقم العميل: ${phone}\n` +
      `آخر رسالة: ${text}\n` +
      `سبب: ${output.human_handover ? 'طلب العميل أو ارتباك واضح' : `لا تقدم بعد ${applied.noProgressTurns} محاولات`}`;
    return {
      logEntry: {
        ...baseFields,
        orderStatus: resolveEarlyStageOrderStatus(applied.orderData, applied.recommendedProduct),
        notes: 'تم التحويل لفريق بشري عبر الوكيل الذكي',
      },
      adminNotification,
    };
  }

  return {
    logEntry: {
      ...baseFields,
      productName: applied.recommendedProduct ? applied.recommendedProduct.name : baseFields.productName,
      orderStatus: resolveEarlyStageOrderStatus(applied.orderData, applied.recommendedProduct),
      notes: `نية العميل (وكيل ذكي): ${output.intent}`,
    },
    adminNotification: undefined,
  };
}

async function handleMessage({ chatId, phone, text, senderName }) {
  const session = getSession(chatId);
  // Captured before anything this turn touches the session — updateSession()
  // stamps a fresh updatedAt on every call below, so this is the one true
  // "how long has this customer been away" reading for buildCustomerProfile.
  const previousUpdatedAt = session.updatedAt;
  const trimmedText = (text || '').trim();

  if (session.nudgeSentAt) {
    updateSession(chatId, { nudgeSentAt: null });
  }

  // Deterministic, free, no API call — an explicit ask for a human must never
  // depend on the LLM correctly reading it as a handover every time.
  if (escalationDetector.isEscalationRequest(trimmedText)) {
    updateSession(chatId, {
      humanHandover: true,
      humanHandoffAt: Date.now(),
      stage: STAGES.CLOSED,
      noProgressTurns: 0,
      orderPlaced: false,
    });
    return buildEscalationResponse(getSession(chatId), phone, trimmedText);
  }

  // Deterministic, free, no API call — same reasoning as the escalation
  // check above: whether a delivery gets confirmed or disputed decides a
  // real Sheet status write (Completed vs Issue) and whether the admin gets
  // paged, so it must never depend on the LLM correctly reading intent every
  // time. Only runs when deliveryFollowup.js actually sent the "did it
  // arrive ok?" message for this customer — never fires on ordinary chat.
  if (session.awaitingDeliveryFeedback) {
    const classification = deliveryFeedbackDetector.classifyDeliveryFeedback(trimmedText);
    if (classification === 'positive') {
      updateSession(chatId, { awaitingDeliveryFeedback: false, orderPlaced: true, stage: STAGES.CLOSED });
      await googleSheets.updateOrderStatus(phone, 'Completed');
      return {
        reply: 'الحمد لله! 🥰 سعيدة إنك استلمتي طلبك وعجبك. لو احتجتي أي حاجة تانية، أنا موجودة.',
        logEntry: {
          ...baseLogFields(getSession(chatId), phone, trimmedText),
          orderStatus: 'Completed',
          notes: 'العميل أكد استلام الطلب بنجاح (بعد رسالة المتابعة التلقائية)',
        },
      };
    }
    if (classification === 'negative') {
      updateSession(chatId, { awaitingDeliveryFeedback: false });
      await googleSheets.updateOrderStatus(phone, 'Issue');
      const adminNotification =
        `⚠️ عميل أبلغ عن مشكلة في التوصيل\n` +
        `رقم العميل: ${phone}\n` +
        `رسالته: ${trimmedText}`;
      return {
        reply: 'يا خبر 💔 آسفة جداً إنك واجهتي مشكلة. هبعتلك حد من فريقنا يتواصل معاكي فوراً عشان نحل الموضوع.',
        logEntry: {
          ...baseLogFields(getSession(chatId), phone, trimmedText),
          orderStatus: 'Issue',
          notes: `العميل أبلغ عن مشكلة بعد التوصيل: ${trimmedText}`,
        },
        adminNotification,
      };
    }
    // classification === null (ambiguous) — fall through to the normal LLM
    // flow below. buildSystemPrompt's awaitingDeliveryFeedback param tells
    // Sara to ask a clarifying question rather than assume either way, and
    // session.awaitingDeliveryFeedback stays true so the next reply gets
    // another chance at deterministic classification.
  }

  const candidates = selectCandidatesForTurn(trimmedText, {
    excludeIds: session.shownProductIds || [],
    recommendedProduct: session.recommendedProduct,
  });
  // Routine-bundle upsell: only offered off the top (best-matched) candidate,
  // and only if it isn't already one of the two products in the bundle pair
  // itself (skip offering a moisturizer as its own bundle complement, or
  // re-offering the same pairing turn after turn once both are already shown).
  const bundleComplement = candidates[0] ? routineBundles.getBundleComplement(candidates[0].id) : null;
  const validBundleComplement =
    bundleComplement && !(session.shownProductIds || []).includes(bundleComplement.id) ? bundleComplement : null;
  const customerProfile = buildCustomerProfile(phone, previousUpdatedAt);
  const systemInstruction = buildSystemPrompt(
    candidates,
    validBundleComplement,
    Boolean(session.secondNudgeSentAt),
    customerProfile,
    Boolean(session.awaitingDeliveryFeedback)
  );
  const history = (session.llm && session.llm.history) || [];
  const contents = [...history, { role: 'user', parts: [{ text: trimmedText }] }];

  // Tier order: local -> openai -> gemini. Canary allowlist (localAgentTestChatIds)
  // was removed 2026-07-13 to roll the fine-tuned local model out to 100% of
  // traffic; openai/gemini remain as the fallback chain if local fails.
  const useLocal = config.localAgentEnabled;
  const callArgs = { systemInstruction, contents, responseSchema: RESPONSE_SCHEMA };

  const tiers = [];
  if (useLocal) tiers.push({ name: 'local', call: () => localService.generateStructuredReply(callArgs) });
  tiers.push({ name: 'openai', call: () => openaiService.generateStructuredReply(callArgs) });
  if (config.geminiFallbackEnabled) tiers.push({ name: 'gemini', call: () => geminiService.generateStructuredReply(callArgs) });

  // Try every tier in order, and — critically — keep going not just when a
  // tier's API call fails outright, but also when it returns schema-valid
  // JSON that fails content validation (bad product reference, unverified
  // price, empty reply_text). Previously a single tier's content failure went
  // straight to the canned fallback without ever trying the next tier, which
  // is how a customer's order-completing message (e.g. just stating their
  // name) could be silently lost when the first tier to respond produced
  // invalid content.
  let validated = null;
  let providerUsed = null;
  for (const tier of tiers) {
    const raw = await tier.call();
    if (!raw) {
      logger.warn(`${tier.name} unavailable — trying next tier.`);
      continue;
    }
    const candidate = validateModelOutput(sanitizeModelOutput(raw), candidates, validBundleComplement);
    if (candidate) {
      validated = candidate;
      providerUsed = tier.name;
      agentStats.recordTierUsage(tier.name);
      break;
    }
    logger.warn(`${tier.name} returned a reply that failed validation — trying next tier.`);
  }

  // Distill every validated teacher-tier (openai/gemini) reply into a
  // training example for the local model — never for providerUsed==='local'
  // itself, since that's the tier we're trying to improve, not imitate.
  if (validated && providerUsed !== 'local') {
    trainingDataLogger.logTrainingExample({ systemInstruction, contents, output: validated, providerUsed });
  }

  if (!validated) {
    agentStats.recordTierUsage('failed');
    // Both providers failed, or validation rejected the surviving output —
    // the bot must never go silent AND must never silently drop what the
    // customer just said. Previously this returned without touching the
    // session at all, so a customer's phone number or address typed on a
    // failed turn was gone for good — the next successful turn would have no
    // idea it was ever sent. Persist the raw message into history (so the
    // next successful call still has full context and can act on it) and
    // opportunistically recover a phone number via a narrow heuristic when
    // one is clearly missing (see recoverOrderDataOnFailure).
    const historyAfterUser = pushHistory(history, 'user', trimmedText);
    const recoveredOrderData = recoverOrderDataOnFailure(session, trimmedText);

    updateSession(chatId, {
      llm: { history: historyAfterUser },
      orderData: recoveredOrderData,
    });

    const logEntry = {
      ...baseLogFields(getSession(chatId), phone, trimmedText),
      orderStatus: resolveEarlyStageOrderStatus(recoveredOrderData, session.recommendedProduct),
      notes: 'تعذر توليد رد موثوق من الذكاء الاصطناعي (محلي/OpenAI/Gemini) - تم حفظ الرسالة للمتابعة في المحاولة التالية',
    };
    // Every configured tier (local + openai + gemini, whichever are enabled)
    // failed or got rejected by validation for this turn — worth a human's
    // attention, unlike a single tier falling through to the next one, which
    // is routine and would make this alert too noisy to act on.
    const adminNotification =
      `⚠️ فشلت كل طبقات الذكاء الاصطناعي في الرد (محلي/OpenAI/Gemini)\n` +
      `رقم العميل: ${phone}\n` +
      `آخر رسالة: ${trimmedText}`;
    return { reply: `${MESSAGES.fallback}\n${MESSAGES.noProductDataDisclaimer}`, logEntry, adminNotification };
  }

  const applied = applyValidatedOutput(session, validated, candidates);

  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'model', validated.reply_text);

  updateSession(chatId, {
    stage: applied.stage,
    orderData: applied.orderData,
    noProgressTurns: applied.noProgressTurns,
    humanHandover: applied.humanHandover,
    // Stamped fresh whenever a handover is flagged this turn, otherwise left
    // untouched. Safe from re-extending the cooldown on every turn while
    // already muted — the client-level cooldown check (see whatsapp/client.js)
    // stops handleMessage from ever being called again until it expires, so
    // this only ever fires on a genuinely new handoff.
    humanHandoffAt: applied.humanHandover ? Date.now() : session.humanHandoffAt,
    orderPlaced: applied.orderConfirmed || session.orderPlaced,
    recommendedProduct: applied.recommendedProduct,
    shownProductIds: applied.shownProductIds,
    customerName: applied.orderData.customerName || session.customerName,
    deliveryAddress: applied.orderData.deliveryAddress || session.deliveryAddress,
    llm: { history: historyAfterModel },
  });

  const { logEntry, adminNotification, orderHistoryEntry } = buildLogEntryAndNotification(
    getSession(chatId),
    phone,
    trimmedText,
    validated,
    applied
  );

  return {
    reply: validated.reply_text,
    logEntry,
    adminNotification,
    orderHistoryEntry,
    variantId:
      providerUsed === 'local'
        ? 'llm_local_v1'
        : providerUsed === 'openai'
        ? 'llm_openai_fallback_v1'
        : providerUsed === 'gemini'
        ? 'llm_gemini_fallback_v1'
        : null,
  };
}

module.exports = {
  handleMessage,
  pushHistory,
  // Exposed so scripts/generateSyntheticData.js can reuse the exact same
  // sanitize/validate gate real production traffic goes through, instead of
  // maintaining a second copy that could drift out of sync.
  sanitizeModelOutput,
  validateModelOutput,
  selectCandidatesForTurn,
};
