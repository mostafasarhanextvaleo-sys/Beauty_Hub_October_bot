const { getSession, updateSession, STAGES, isDeliveryFeedbackExpired } = require('./conversationMemory');
const escalationDetector = require('./escalationDetector');
const { containsAny, containsWord, normalizeArabic } = require('../utils/helpers');
const { buildEscalationResponse, baseLogFields, resolveEarlyStageOrderStatus } = require('./sessionLogHelpers');
const deliveryFeedbackDetector = require('./deliveryFeedbackDetector');
const orderStatusDetector = require('./orderStatusDetector');
const websiteOrderDetector = require('./websiteOrderDetector');
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
const campaignKnowledge = require('./campaignKnowledge');
const googleSheets = require('../services/googleSheets');

// Rolling window, not the full conversation — bounds prompt size/cost/latency
// so a long-running customer's per-message cost doesn't keep growing forever
// and can never exceed the model's context window. 40 entries (~20 user/model
// turn pairs) was chosen from real production data (training-data/conversations.jsonl,
// 2026-07-27 audit), not a round number: 60 covered every real conversation
// seen so far (max 63 entries) but so does 40 — it lands at roughly the p95 of
// real history lengths, trading a small tail of very long conversations for
// meaningfully smaller prompts on the common case. Going lower (e.g. 20) was
// evaluated and rejected: 16% of real logged conversations already exceed 20
// entries, so that cap would make Sara visibly forget facts (skin type,
// budget, name) a customer already gave earlier in the same conversation. The
// full, untruncated history is still captured separately in Google Sheets'
// Conversation History note and in training-data/conversations.jsonl (see
// trainingDataLogger.js) for the 2-month data-gathering goal, regardless of
// what's replayed into the live prompt.
const MAX_HISTORY_TURNS = 40;

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

// 2026-08-02 audit fix: MAX_NO_PROGRESS_TURNS above only ever counts turns
// while order-collection is active (see applyValidatedOutput's
// orderCollectionActive gate) — a customer repeating the exact same message
// ("تم" twice, observed live) outside that window sailed straight past it
// with no escalation at all, and the bot just repeated its own canned reply
// back. This is a separate, independent counter for exactly that case: 2
// consecutive identical messages (the 3rd occurrence) forces a handover,
// same "3 strikes" severity as MAX_NO_PROGRESS_TURNS, checked deterministically
// in handleMessage before any LLM call — see there for the short-circuit.
const MAX_CONSECUTIVE_REPEATS = 2;

// 2026-07-18: deterministic ground-truth guard on SPECIALIST_REFERRAL — the
// same "trust but verify" principle validateModelOutput already applies to
// prices and product ids (never trust the model's own claim, check it
// against real data), extended to the human-handover decision. sim_run3/
// sim_run4, and a live harness re-test of the llmSystemPrompt.js prompt-only
// fix (explicit top-of-prompt rule + few-shot examples), both showed
// gpt-4o-mini still escalating a bare "حبوب" or "عندي حبوب بتضايقني" reply to
// SPECIALIST_REFERRAL and skipping any product recommendation — prompt
// wording alone doesn't reliably override this model's caution bias on skin/
// health topics for a single, context-free word. This backstop never trusts
// handover_reason==="SPECIALIST_REFERRAL" at face value; see
// applyValidatedOutput below.
//
// 'دم' (blood) and 'ألم' (pain) are checked as whole words (containsWord),
// not substring — unlike the rest of this list they're short roots that
// collide with extremely common, unrelated words once normalizeArabic
// (helpers.js) folds أ/إ/آ all down to plain ا: 'ألم' normalizes to 'الم',
// which is a literal substring of 'المتاح' ("available") — confirmed live
// when a persona's "ايه المتاح؟" false-matched this keyword, suppressed the
// guard, and let a bare escalation slip through uncaught. 'دم' has the same
// problem with 'خدمة' ("خدمة العملاء", said constantly by customers). 'وجع'
// is added alongside the literal "بتوجعني" so a genuine pain report still
// matches across the many Arabic verb conjugations (وجعني/ووجعاني/هتوجعني/etc.)
// a single fixed spelling would miss — under-matching here would let a real
// severe case slip through as "routine".
const SPECIALIST_REFERRAL_KEYWORDS = [
  'كيسي', 'كيسية', 'ملتهب', 'ملتهبة', 'تورم', 'نزيف',
  'دكتور', 'دكتورة', 'متخصص', 'وجع', 'بتوجعني',
];
const SPECIALIST_REFERRAL_WORD_KEYWORDS = ['دم', 'ألم'];

function hasClinicalSeverityKeyword(text) {
  return containsAny(text, SPECIALIST_REFERRAL_KEYWORDS) || containsWord(text, SPECIALIST_REFERRAL_WORD_KEYWORDS);
}

// Replaces the model's own (rejected) hand-off line when SPECIALIST_REFERRAL
// is downgraded — never show the customer a specialist hand-off message for
// what code has determined is actually a routine case. Deliberately generic
// and product-free: rule 8 forbids inventing a product outside this turn's
// candidate list, and there's no model-authored alternative reply_text safe
// to trust here, so this keeps the conversation open for a real
// recommendation on the next turn instead of dead-ending on a false handover.
const NORMAL_CONSULTATION_FALLBACK =
  'تمام، ده موضوع عادي جدًا وهساعدك فيه زي أي استشارة تانية 💛 لو حابة تضيفي أي تفاصيل زي روتين العناية الحالي أو الميزانية التقريبية، هقدر أرشحلك أنسب منتج من عندنا فورًا.';

// Canonical in-memory shape is the OpenAI chat format directly —
// {role: 'user'|'assistant', content: string} — since OpenAI is now the
// primary tier. localService.js/openaiService.js consume this as-is;
// geminiService.js is the only tier with a different dialect, so it converts
// on its own side (toGeminiContents) rather than everyone converting for it.
function pushHistory(history, role, text) {
  return [...history, { role, content: text }].slice(-MAX_HISTORY_TURNS);
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
  // 2026-07-18 audit: PHONE_LIKE never routed through normalizeArabic, so a
  // customer typing their alt phone in Arabic-Indic numerals (e.g. ٠١٠١٢٣...)
  // silently failed to match at all — normalizeArabic now also folds those
  // to plain digits, so this is the fix, not just a stylistic pass.
  const normalizedText = normalizeArabic(text);
  if (missingAltPhone && PHONE_LIKE.test(normalizedText)) {
    return { ...orderData, altPhone: normalizedText.trim() };
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

// 2026-07-18 audit: candidates used to come from searching THAT turn's raw
// text alone, with nothing carried over from earlier in the same
// consultation. Confirmed empirically to break exactly the moment the
// 4-step consultation (llmSystemPrompt.js rule 2) reaches its last step: a
// bare budget answer like "200 جنيه بس" matched unrelated products purely on
// an incidental "200 مل" size spec, and a natural "اقتصادي"/"حابة حاجة رخيصة"
// reply returned ZERO candidates — right at the turn the customer is most
// ready to buy, forcing rule 8's "the team will confirm availability"
// fallback instead of the recommendation the consultation was building
// toward. Folding in the last couple of user turns (already sitting in
// session.llm.history — no new state needed) re-introduces the skin-type/
// problem words the bare final answer alone doesn't carry.
const SEARCH_QUERY_HISTORY_WINDOW = 2;

function buildSearchQuery(session, currentText) {
  const history = (session.llm && session.llm.history) || [];
  const recentUserTurns = history
    .filter((turn) => turn.role === 'user')
    .slice(-SEARCH_QUERY_HISTORY_WINDOW)
    .map((turn) => turn.content);
  return [...recentUserTurns, currentText].filter(Boolean).join(' ');
}

// The model still needs to reference the item actually being ordered even on
// a turn whose (now rolling-window) search text doesn't happen to match it,
// so the currently-recommended product is always folded back in regardless
// — without this, order-confirmation turns get validated-rejected for
// referencing "a product outside this turn's candidate list" when that
// product is exactly the one from a prior turn the model (correctly) still
// has in mind. campaignOfferProduct (2026-08-02 audit fix) is the same idea
// applied to a campaign send: session.campaignOfferProduct is stashed by
// campaignWorker.js's appendOfferToSessionHistory when a customer receives
// an offer linked to a real catalog product, so a reply like "عايزة عرض
// مبرد القدم" is always groundable/quotable even if that exact product
// wouldn't otherwise surface from this turn's own search query.
async function selectCandidatesForTurn(text, { excludeIds = [], recommendedProduct = null, campaignOfferProduct = null } = {}) {
  const candidates = await productSearch.searchProducts(text, { excludeIds });
  let merged = candidates;
  [recommendedProduct, campaignOfferProduct].forEach((sticky) => {
    if (sticky && !merged.some((p) => p.id === sticky.id)) {
      merged = [sticky, ...merged];
    }
  });
  return merged;
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
    // normalizeArabic folds Arabic-Indic digits (e.g. "١٦٠") to plain ASCII
    // before \D strips everything else — without it, an Arabic-Indic price
    // silently stripped to an empty string and skipped verification entirely
    // (2026-07-18 audit).
    const quotedDigits = normalizeArabic(output.price_quoted).replace(/\D/g, '');
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
      const quotedDigits = normalizeArabic(routineBundlePriceQuoted).replace(/\D/g, '');
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
function applyValidatedOutput(session, output, candidates, text) {
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
  // Root cause of the 2026-08-02 triple-logging incident: order fields stay
  // present in session.orderData forever once collected, and the model keeps
  // asserting order_data.confirmed=true on later turns of the same closed
  // conversation (e.g. a customer correcting phrasing after "تم تأكيد الطلب
  // بنجاح") — with nothing here checking whether this session's order was
  // already confirmed, each such turn re-triggered the full order-confirmed
  // branch (admin notification + a new Order History/Confirmed_Orders row).
  // session.orderPlaced is sticky for the life of the session (only ever
  // reset to false by the escalation handler), so this makes "confirmed"
  // fire at most once per order episode.
  const orderConfirmed = allFieldsPresent && output.order_data.confirmed === true && !session.orderPlaced;

  let humanHandover = output.human_handover === true || noProgressTurns >= MAX_NO_PROGRESS_TURNS;
  // Only trusted when the MODEL itself asserted the handover (persona rule
  // 10) — the noProgressTurns backstop above can also set humanHandover=true
  // with no corresponding handover_reason from the model, which must fall
  // through to the generic "handed to a human" logging, not be mistaken for
  // a specialist referral.
  let handoverReason = output.human_handover === true ? output.handover_reason || null : null;

  // Deterministic ground-truth check (see hasClinicalSeverityKeyword above) —
  // never trust a SPECIALIST_REFERRAL assertion at face value. If the
  // customer's actual message has no real clinical severity signal, this is
  // almost certainly the over-caution bug (bare "حبوب", "عندي حبوب
  // بتضايقني", etc.), not a genuine severe/cystic case — downgrade back to a
  // normal consultation rather than handing off.
  // Ground truth is the actual text the customer is about to receive, not
  // just the structured flags — a live re-test surfaced calls where the
  // model wrote the exact SPECIALIST_REFERRAL sentence into reply_text while
  // leaving human_handover=false (an internally inconsistent structured
  // output), which would slip straight past a guard that only checked
  // handoverReason: humanHandover would already be false, so nothing would
  // look like it needed downgrading, yet the customer would still be told
  // "you need a specialist" via reply_text alone. Checking reply_text
  // directly (persona rule 10-b requires the model reproduce this sentence
  // verbatim, so matching on it is reliable) closes that gap regardless of
  // whether the model's own fields agree with its own prose.
  const SPECIALIST_REFERRAL_REPLY_MARKER = 'محتاجة متابعة من فريقنا المتخصص';
  const assertsSpecialistReferral =
    handoverReason === 'SPECIALIST_REFERRAL' ||
    (typeof output.reply_text === 'string' && output.reply_text.includes(SPECIALIST_REFERRAL_REPLY_MARKER));

  let specialistReferralDowngraded = false;
  if (assertsSpecialistReferral && !hasClinicalSeverityKeyword(text)) {
    logger.warn(
      `LLM agent asserted SPECIALIST_REFERRAL (handover_reason and/or reply_text) with no clinical severity keyword in the customer's message ("${text}") — downgrading to a normal consultation instead of handing off.`
    );
    humanHandover = false;
    handoverReason = null;
    specialistReferralDowngraded = true;
  }

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

  return {
    orderData,
    orderConfirmed,
    humanHandover,
    handoverReason,
    stage,
    recommendedProduct,
    shownProductIds,
    noProgressTurns,
    specialistReferralDowngraded,
  };
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
    // "SPECIALIST_REFERRAL" (persona rule 10-b: severe/cystic acne or an
    // explicit ask for a dermatologist) gets its own Order Status —
    // deliberately NOT "Issue", which staff already use specifically for a
    // confirmed delivery problem (see deliveryFeedbackDetector.js's
    // 'Issue' write). Conflating the two would make staff filtering by
    // "Issue" surface skin-consultation referrals mixed in with real
    // delivery complaints.
    if (applied.handoverReason === 'SPECIALIST_REFERRAL') {
      const adminNotification =
        `🩺 حالة تحتاج متابعة متخصصة (وكيل ذكي)\n` +
        `رقم العميل: ${phone}\n` +
        `آخر رسالة: ${text}`;
      return {
        logEntry: {
          ...baseFields,
          orderStatus: 'Needs Specialist',
          notes: 'العميلة وصفت حالة جلدية تحتاج متابعة متخصصة - تم تحويلها لفريق Beauty Hub October',
        },
        adminNotification,
      };
    }

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

// Maps the Leads sheet's live Order Status to a customer-facing reply. Status
// semantics here match resolveEarlyStageOrderStatus (sessionLogHelpers.js)
// exactly, since that's what actually writes these values under AGENT_MODE=llm:
// 'Pending' = order data (name/address/alt phone/product) still being
// collected, no confirmed order yet; 'In Progress' = all of that IS collected
// but the customer hasn't given final confirmation yet — genuinely "your
// order is basically ready, just needs your yes"; 'Completed' = confirmed;
// 'Issue' = a delivery problem was reported; 'Needs Specialist' = the LLM
// referred the customer to the store's team over a severe/cystic skin
// condition or an explicit ask for a dermatologist (persona rule 10-b,
// llmSystemPrompt.js) — deliberately distinct from 'Issue' since it's a
// pre-purchase consult referral, not a delivery complaint; 'Delivered' is
// staff-set directly in the Sheet UI (see deliveryFollowup.js), never
// written by the bot itself. 'Cancelled' can only appear on rows from
// before AGENT_MODE=llm went live (the rules engine sets it; the LLM agent
// never does).
function buildOrderStatusReply(statusInfo) {
  if (!statusInfo || !statusInfo.orderStatus || statusInfo.orderStatus === 'Pending') {
    return 'لسه مفيش طلب اتأكد منك خالص 🌸 لو حابة تطلبي أو تعرفي منتجاتنا قوليلي محتاجة ايه وأنا هساعدك.';
  }

  const productNote = statusInfo.productName ? ` (${statusInfo.productName})` : '';

  switch (statusInfo.orderStatus) {
    case 'Pending - Website Order':
      return `طلبك اللي بعتيه من الموقع وصلنا فعلاً وجاري تجهيزه 🚀 فريقنا بيراجعه دلوقتي قبل الشحن، وهيتواصل معاكِ لو محتاجين أي تأكيد زيادة.`;
    case 'In Progress':
      return `بياناتك اتسجلت وطلبك${productNote} جاهز، محتاجين بس تأكيدك النهائي عشان نبدأ التجهيز 📝 تحبي تأكدي الطلب دلوقتي؟`;
    case 'Completed':
      return `تم تأكيد طلبك${productNote} وهو بيتجهز للشحن دلوقتي 📦 هيوصلك قريب ان شاء الله.`;
    case 'Delivered':
      return `طلبك${productNote} وصل واتسلم بالفعل ✅ لو في أي حاجة تانية محتاجة مساعدة فيها قوليلي.`;
    case 'Issue':
      return `في مشكلة اتسجلت على طلبك${productNote} وفريقنا هيتواصل معاكي في أقرب وقت عشان نحلها 🙏`;
    case 'Needs Specialist':
      return 'فريق Beauty Hub October هيتابع معاكي بخصوص استشارتك في أقرب وقت 🌸 لو حابة تسألي حاجة تانية دلوقتي، أنا هنا.';
    case 'Cancelled':
      return 'الطلب ده كان اتلغى. لو حابة تطلبي تاني قوليلي محتاجة ايه وهساعدك.';
    default:
      // Unknown/unexpected status value — don't guess, don't go silent.
      return 'مش قادرة أجيب حالة طلبك بالظبط دلوقتي، هبعتلك حد من فريقنا يتأكد منك في أقرب وقت.';
  }
}

// Deterministic order-status lookup (see orderStatusDetector.js) — reads the
// live Sheet rather than anything cached in the session, since Order Status
// can change from a staff edit (e.g. "Delivered") that never touches session
// state. Participates in history/logging exactly like any other turn (so the
// next AI call still has full context) but never calls an AI tier itself.
async function handleOrderStatusInquiry({ chatId, phone, trimmedText, history }) {
  const statusInfo = await googleSheets.getCurrentOrderStatus(phone);
  const reply = buildOrderStatusReply(statusInfo);

  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', reply);
  updateSession(chatId, { llm: { history: historyAfterModel } });

  return {
    reply,
    logEntry: {
      ...baseLogFields(getSession(chatId), phone, trimmedText),
      // Passing back exactly what was just read (never a guessed/different
      // value) keeps this a no-op for the column on appendLead's upsert —
      // it can never clobber a staff-set status like "Delivered".
      orderStatus: (statusInfo && statusInfo.orderStatus) || 'Pending',
      notes: `العميل سأل عن حالة الطلب - تم الرد تلقائياً من بيانات الشيت (${statusInfo ? statusInfo.orderStatus || 'غير محدد' : 'لا يوجد طلب مسجل'})`,
    },
  };
}

// Deterministic, free, no API call (see websiteOrderDetector.js for why:
// a recognized order's product/price/order-number facts are already fully
// known from the parsed text — there is nothing for an AI tier to usefully
// decide here, only hallucination risk to introduce). Logged as "Pending -
// Website Order", not "Completed" — plain WhatsApp text has no cryptographic
// link to a real completed transaction, so a human still glances at it
// before dispatch (store owner's explicit call, 2026-07-30). Note the
// website checkout flow never collects a delivery address, so the admin
// notification flags that explicitly rather than silently leaving it blank.
async function handleWebsiteOrder({ chatId, phone, trimmedText, session, order }) {
  const itemsSummary = websiteOrderDetector.summarizeItems(order.items);
  const totalLabel = order.totalPrice ? `${order.totalPrice} جنيه` : 'غير محدد';

  const reply =
    `أهلاً بيكِ 🌸 تم استلام طلبك بنجاح وجاري تجهيزه الآن 🚀\n\n` +
    `رقم الطلب: ${order.orderNumber || 'غير محدد'}\n` +
    `المنتجات: ${itemsSummary || 'غير محدد'}\n` +
    `الإجمالي: ${totalLabel}\n\n` +
    `لو محتاجة أي تفاصيل زيادة أو حابة تتابعي حالة الطلب، أنا هنا 🌸`;

  const history = (session.llm && session.llm.history) || [];
  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', reply);

  updateSession(chatId, {
    websiteOrder: { ...order, itemsSummary, receivedAt: Date.now() },
    stage: STAGES.CLOSED,
    noProgressTurns: 0,
    customerName: order.customerName || session.customerName,
    llm: { history: historyAfterModel },
  });

  const adminNotification =
    `🛒 طلب جديد من الموقع (Pending — يحتاج مراجعة قبل الشحن)\n` +
    `رقم الطلب: ${order.orderNumber || 'غير محدد'}\n` +
    `الاسم: ${order.customerName || 'غير محدد'}\n` +
    `التليفون: ${order.phone || phone}\n` +
    `المنتجات: ${itemsSummary || 'غير محدد'}\n` +
    `الإجمالي: ${totalLabel}\n` +
    `⚠️ الموقع مبيجمعش عنوان التوصيل — لازم ياخده حد من الفريق من العميلة قبل الشحن.` +
    (order.orderNotes ? `\nملاحظات العميلة: ${order.orderNotes}` : '');

  return {
    reply,
    logEntry: {
      ...baseLogFields(getSession(chatId), phone, trimmedText),
      customerName: order.customerName || session.customerName || '',
      productName: itemsSummary,
      altPhone: order.phone && order.phone !== phone ? order.phone : '',
      orderStatus: 'Pending - Website Order',
      notes:
        `طلب من الموقع — رقم الطلب ${order.orderNumber || 'غير محدد'}, يحتاج مراجعة قبل الشحن (مفيش عنوان توصيل من الموقع).` +
        (order.orderNotes ? ` ملاحظات العميلة: ${order.orderNotes}` : ''),
    },
    adminNotification,
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

  // Deterministic repetition-loop guard (2026-08-02 audit fix) — a customer
  // repeating their exact previous message verbatim is checked against
  // session state as it stood BEFORE this turn (session.llm.history hasn't
  // been updated with trimmedText yet). normalizeArabic keeps this in sync
  // with how digit/text comparisons elsewhere in this file are normalized,
  // so trivial Arabic-Indic-digit or whitespace differences don't defeat it.
  const priorUserTurns = ((session.llm && session.llm.history) || []).filter((turn) => turn.role === 'user');
  const lastUserText = priorUserTurns.length > 0 ? priorUserTurns[priorUserTurns.length - 1].content : null;
  const isRepeatedMessage = Boolean(trimmedText && lastUserText && normalizeArabic(lastUserText).trim() === normalizeArabic(trimmedText).trim());
  const consecutiveRepeats = isRepeatedMessage ? (session.consecutiveRepeats || 0) + 1 : 0;

  if (consecutiveRepeats >= MAX_CONSECUTIVE_REPEATS) {
    updateSession(chatId, {
      humanHandover: true,
      humanHandoffAt: Date.now(),
      stage: STAGES.CLOSED,
      noProgressTurns: 0,
      consecutiveRepeats: 0,
    });
    return {
      reply: 'حسيت إن ردودي مش بتوصلك صح 🌸 خليني أوصلك بفريقنا يقدروا يساعدوك بشكل مباشر أكتر.',
      logEntry: {
        ...baseLogFields(getSession(chatId), phone, trimmedText),
        notes: `العميل كرر نفس الرسالة ${consecutiveRepeats + 1} مرات متتالية من غير تقدم — تم التحويل تلقائيًا لفريق بشري`,
      },
      adminNotification: `🔁 عميل كرر نفس الرسالة عدة مرات من غير رد مفيد — تم التحويل تلقائيًا\nرقم العميل: ${phone}\nالرسالة: ${trimmedText}`,
    };
  }

  // Deterministic, free, no API call — see websiteOrderDetector.js. Checked
  // early, same priority tier as escalation above: a recognized website
  // order is a very specific structural signal that should short-circuit
  // immediately rather than fall through to the general LLM flow.
  const websiteOrder = websiteOrderDetector.parseWebsiteOrder(trimmedText);
  if (websiteOrder) {
    return handleWebsiteOrder({ chatId, phone, trimmedText, session, order: websiteOrder });
  }

  // A "did it arrive ok?" follow-up left unanswered for 48h+ is stale — a
  // reply days later (e.g. an unrelated new order) must not be misread as
  // delivery-confirmation feedback and silently closed as Completed/Issue.
  // Expire it and fall through to normal handling below.
  if (isDeliveryFeedbackExpired(session)) {
    updateSession(chatId, { awaitingDeliveryFeedback: false, deliveryFeedbackRequestedAt: null });
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
      updateSession(chatId, {
        awaitingDeliveryFeedback: false,
        deliveryFeedbackRequestedAt: null,
        orderPlaced: true,
        stage: STAGES.CLOSED,
      });
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
      // A confirmed delivery issue hands the customer to a human immediately
      // (2026-07-18 spec) — same 24h cooldown as an explicit escalation
      // request above, so the bot goes silent and the admin team handles it
      // without automated interference.
      updateSession(chatId, {
        awaitingDeliveryFeedback: false,
        deliveryFeedbackRequestedAt: null,
        humanHandoffAt: Date.now(),
      });
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

  // Deterministic, free, no API call — same reasoning as escalation/delivery-
  // feedback above: "where's my order" must answer from the live Sheet
  // status, never from whatever the LLM guesses or half-remembers from
  // conversation history. Runs before any AI tier so it never costs a token.
  if (orderStatusDetector.isOrderStatusInquiry(trimmedText)) {
    return handleOrderStatusInquiry({ chatId, phone, trimmedText, session, history: (session.llm && session.llm.history) || [] });
  }

  // Rolling-window query (see buildSearchQuery above) — not bare trimmedText
  // — so a terse final-step answer in the consultation still carries the
  // skin-type/problem context from the turns just before it.
  const searchQuery = buildSearchQuery(session, trimmedText);
  const candidates = await selectCandidatesForTurn(searchQuery, {
    excludeIds: session.shownProductIds || [],
    recommendedProduct: session.recommendedProduct,
    campaignOfferProduct: session.campaignOfferProduct,
  });
  // Routine-bundle upsell: only offered off the top (best-matched) candidate,
  // and only if it isn't already one of the two products in the bundle pair
  // itself (skip offering a moisturizer as its own bundle complement, or
  // re-offering the same pairing turn after turn once both are already shown).
  const bundleComplement = candidates[0] ? routineBundles.getBundleComplement(candidates[0].id) : null;
  const validBundleComplement =
    bundleComplement && !(session.shownProductIds || []).includes(bundleComplement.id) ? bundleComplement : null;
  const customerProfile = buildCustomerProfile(phone, previousUpdatedAt);
  const websiteOrderForPrompt = session.websiteOrder
    ? { ...session.websiteOrder, itemsSummary: websiteOrderDetector.summarizeItems(session.websiteOrder.items) }
    : null;
  const systemInstruction = buildSystemPrompt(
    candidates,
    validBundleComplement,
    Boolean(session.secondNudgeSentAt),
    customerProfile,
    Boolean(session.awaitingDeliveryFeedback),
    websiteOrderForPrompt,
    campaignKnowledge.getActiveOffers(),
    // Soft repetition-loop nudge — exactly the 2nd identical message in a
    // row (the hard MAX_CONSECUTIVE_REPEATS handover above only fires on the
    // 3rd), so the model gets one chance to break the loop itself before the
    // deterministic escalation takes over.
    consecutiveRepeats === 1
  );
  const history = (session.llm && session.llm.history) || [];
  const contents = [...history, { role: 'user', content: trimmedText }];

  // Tier order when enabled: local -> openai -> gemini. The local fine-tuned
  // model was briefly rolled out to 100% of traffic starting 2026-07-13, but
  // as of 2026-07-18 LOCAL_AGENT_ENABLED=false in the live .env — the bot is
  // currently serving all traffic from openai (primary) -> gemini (fallback)
  // only. The local tier's code path here is intentionally left intact
  // (not dead code) so it can be re-enabled via config without a deploy.
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
      consecutiveRepeats,
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

  const applied = applyValidatedOutput(session, validated, candidates, trimmedText);

  // A downgraded SPECIALIST_REFERRAL means validated.reply_text is still the
  // model's (now-rejected) hand-off line — swap it for the generic
  // continuation before it's saved to history or returned to the customer,
  // so the two are never inconsistent (customer told "you need a
  // specialist" while everything else in the system treats it as routine).
  if (applied.specialistReferralDowngraded) {
    validated.reply_text = NORMAL_CONSULTATION_FALLBACK;
  }

  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', validated.reply_text);

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
    // Persists the repetition count computed near the top of this function
    // (0 if this turn's message didn't repeat the last one) so next turn's
    // comparison has the right running count — see MAX_CONSECUTIVE_REPEATS.
    consecutiveRepeats,
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
