const { getSession, updateSession, STAGES } = require('./conversationMemory');
const escalationDetector = require('./escalationDetector');
const { buildEscalationResponse, baseLogFields } = require('./sessionLogHelpers');
const productSearch = require('./productSearch');
const geminiService = require('../services/geminiService');
const openaiService = require('../services/openaiService');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('./llmSystemPrompt');
const { MESSAGES } = require('./prompts');
const config = require('../config');
const logger = require('../utils/logger');

// Rolling window, not the full conversation — bounds prompt size/cost. ~10
// user/model turn pairs is enough for the model to track context and avoid
// re-asking things without re-sending the whole conversation every call.
const MAX_HISTORY_TURNS = 20;

// Hard backstop against infinite loops, independent of what the model says —
// mirrors the legacy rule engine's MAX_UNCLEAR_CONFIRMATION_ATTEMPTS pattern.
const MAX_NO_PROGRESS_TURNS = 3;

function pushHistory(history, role, text) {
  return [...history, { role, parts: [{ text }] }].slice(-MAX_HISTORY_TURNS);
}

// Every mentioned product id must come from THIS turn's candidate list (never
// the full catalog) — rejecting the whole reply otherwise is safer than
// guessing what to strip out of an already-written sentence. price_quoted is
// checked digit-for-digit against a mentioned candidate's real price rather
// than scanning reply_text for any number, which would false-positive on
// legitimate non-price digits (product sizes, SPF ratings, etc).
function validateModelOutput(output, candidates) {
  if (!output || typeof output.reply_text !== 'string' || !output.reply_text.trim()) return null;

  const candidateIds = new Set(candidates.map((p) => p.id));
  const mentionedIds = Array.isArray(output.mentioned_product_ids) ? output.mentioned_product_ids : [];
  if (!mentionedIds.every((id) => candidateIds.has(id))) {
    logger.warn(`LLM agent referenced product id(s) outside this turn's candidate list: ${mentionedIds.join(', ')}`);
    return null;
  }

  if (output.price_quoted) {
    const quotedDigits = String(output.price_quoted).replace(/\D/g, '');
    const mentioned = candidates.filter((p) => mentionedIds.includes(p.id));
    const verified = quotedDigits && mentioned.some((p) => String(p.price || '').replace(/\D/g, '') === quotedDigits);
    if (!verified) {
      logger.warn(`LLM agent quoted an unverified price "${output.price_quoted}" — discarding reply.`);
      return null;
    }
  }

  return output;
}

// Code, never the model, decides order completion and human handover — both
// are re-derived here from validated fields rather than trusted as asserted.
function applyValidatedOutput(session, output, candidates) {
  const prevOrder = session.orderData || {};
  const orderData = {
    customerName: (output.order_data.customer_name || '').trim() || prevOrder.customerName || null,
    deliveryAddress: (output.order_data.delivery_address || '').trim() || prevOrder.deliveryAddress || null,
    altPhone: (output.order_data.alt_phone || '').trim() || prevOrder.altPhone || null,
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
    const adminNotification =
      `✅ طلب جديد مكتمل! (وكيل ذكي)\n` +
      `المنتج: ${applied.recommendedProduct ? applied.recommendedProduct.name : 'غير محدد'}\n` +
      `الاسم: ${applied.orderData.customerName || 'غير محدد'}\n` +
      `رقم العميل: ${phone}\n` +
      `رقم بديل: ${applied.orderData.altPhone || 'غير محدد'}\n` +
      `العنوان: ${applied.orderData.deliveryAddress || 'غير محدد'}`;
    return {
      logEntry: {
        ...baseFields,
        productName: applied.recommendedProduct ? applied.recommendedProduct.name : baseFields.productName,
        customerName: applied.orderData.customerName || baseFields.customerName,
        deliveryAddress: applied.orderData.deliveryAddress || baseFields.deliveryAddress,
        orderStatus: 'Completed',
        notes: 'تم تأكيد الطلب عبر الوكيل الذكي (Gemini/OpenAI)',
      },
      adminNotification,
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
        orderStatus: 'In Progress',
        notes: 'تم التحويل لفريق بشري عبر الوكيل الذكي',
      },
      adminNotification,
    };
  }

  return {
    logEntry: {
      ...baseFields,
      productName: applied.recommendedProduct ? applied.recommendedProduct.name : baseFields.productName,
      orderStatus: 'In Progress',
      notes: `نية العميل (وكيل ذكي): ${output.intent}`,
    },
    adminNotification: undefined,
  };
}

async function handleMessage({ chatId, phone, text, senderName }) {
  const session = getSession(chatId);
  const trimmedText = (text || '').trim();

  if (session.nudgeSentAt) {
    updateSession(chatId, { nudgeSentAt: null });
  }

  // Deterministic, free, no API call — an explicit ask for a human must never
  // depend on the LLM correctly reading it as a handover every time.
  if (escalationDetector.isEscalationRequest(trimmedText)) {
    updateSession(chatId, { humanHandover: true, stage: STAGES.CLOSED, noProgressTurns: 0, orderPlaced: false });
    return buildEscalationResponse(getSession(chatId), phone, trimmedText);
  }

  const candidates = productSearch.searchProducts(trimmedText, { excludeIds: session.shownProductIds || [] });
  const systemInstruction = buildSystemPrompt(candidates);
  const history = (session.llm && session.llm.history) || [];
  const contents = [...history, { role: 'user', parts: [{ text: trimmedText }] }];

  let rawOutput = await geminiService.generateStructuredReply({
    systemInstruction,
    contents,
    responseSchema: RESPONSE_SCHEMA,
  });
  let providerUsed = rawOutput ? 'gemini' : null;

  if (!rawOutput && config.geminiFallbackEnabled) {
    logger.warn('Gemini unavailable — falling back to OpenAI gpt-4o-mini for this turn.');
    rawOutput = await openaiService.generateStructuredReply({
      systemInstruction,
      contents,
      responseSchema: RESPONSE_SCHEMA,
    });
    providerUsed = rawOutput ? 'openai' : null;
  }

  const validated = validateModelOutput(rawOutput, candidates);

  if (!validated) {
    // Both providers failed, or validation rejected the surviving output —
    // the bot must never go silent.
    const logEntry = {
      ...baseLogFields(session, phone, trimmedText),
      orderStatus: 'In Progress',
      notes: 'تعذر توليد رد موثوق من الذكاء الاصطناعي (Gemini/OpenAI) - تم استخدام رد احتياطي',
    };
    return { reply: `${MESSAGES.fallback}\n${MESSAGES.noProductDataDisclaimer}`, logEntry };
  }

  const applied = applyValidatedOutput(session, validated, candidates);

  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'model', validated.reply_text);

  updateSession(chatId, {
    stage: applied.stage,
    orderData: applied.orderData,
    noProgressTurns: applied.noProgressTurns,
    humanHandover: applied.humanHandover,
    orderPlaced: applied.orderConfirmed || session.orderPlaced,
    recommendedProduct: applied.recommendedProduct,
    shownProductIds: applied.shownProductIds,
    customerName: applied.orderData.customerName || session.customerName,
    deliveryAddress: applied.orderData.deliveryAddress || session.deliveryAddress,
    llm: { history: historyAfterModel },
  });

  const { logEntry, adminNotification } = buildLogEntryAndNotification(
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
    variantId: providerUsed === 'openai' ? 'llm_openai_fallback_v1' : 'llm_gemini_v1',
  };
}

module.exports = { handleMessage };
