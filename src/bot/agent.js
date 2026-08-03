const { getSession, updateSession, STAGES } = require('./conversationMemory');
const productMatcher = require('./productMatcher');
const { detectIntent, detectAddressConfirmation, INTENT } = require('./orderDetector');
const faqDetector = require('./faqDetector');
const escalationDetector = require('./escalationDetector');
const {
  MESSAGES,
  recommendationMessage,
  orderConfirmationSummary,
  getGreeting,
  CATEGORY_KEYWORDS,
  SKIN_TYPE_KEYWORDS,
  HAIR_TYPE_KEYWORDS,
} = require('./prompts');
const { containsAny } = require('../utils/helpers');
const config = require('../config');
const openaiService = require('../services/openaiService');
const anthropicService = require('../services/anthropicService');
const logger = require('../utils/logger');
const { buildNeedDescription, baseLogFields, buildEscalationResponse } = require('./sessionLogHelpers');
const llmAgent = require('./llmAgent');

function detectCategory(text) {
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (containsAny(text, keywords)) return category;
  }
  return null;
}

function detectSkinType(text) {
  for (const [type, keywords] of Object.entries(SKIN_TYPE_KEYWORDS)) {
    if (containsAny(text, keywords)) return type;
  }
  return null;
}

function detectHairType(text) {
  for (const [type, keywords] of Object.entries(HAIR_TYPE_KEYWORDS)) {
    if (containsAny(text, keywords)) return type;
  }
  return null;
}

function tryDetectCategorySwitch(session, text) {
  const newCategory = detectCategory(text);
  if (newCategory && newCategory !== session.category) {
    return newCategory;
  }
  return null;
}

function handleNew(session, text) {
  updateSession(session.chatId, { greeted: true, stage: STAGES.AWAIT_CATEGORY });
  const greeting = getGreeting();
  return { reply: greeting.text, logEntry: null, variantId: greeting.id };
}

function handleAwaitCategory(session, text, phone) {
  const category = detectCategory(text);

  if (!category) {
    return { reply: MESSAGES.askCategoryAgain, logEntry: null };
  }

  if (category === 'offers') {
    updateSession(session.chatId, { category: 'offers' });
    return { reply: MESSAGES.offers, logEntry: null };
  }

  updateSession(session.chatId, { category });

  if (category === 'skincare') {
    updateSession(session.chatId, { stage: STAGES.AWAIT_ATTRIBUTE });
    return { reply: MESSAGES.askSkinType, logEntry: null };
  }

  if (category === 'haircare') {
    updateSession(session.chatId, { stage: STAGES.AWAIT_ATTRIBUTE });
    return { reply: MESSAGES.askHairType, logEntry: null };
  }

  // makeup / bodycare have no attribute question — recommend directly
  return recommendProduct(getSession(session.chatId), phone, text);
}

function recommendProduct(session, phone, text) {
  const product = productMatcher.findBestMatch({
    category: session.category,
    skinType: session.skinType,
    hairType: session.hairType,
    excludeIds: session.shownProductIds || [],
  });

  if (!product) {
    updateSession(session.chatId, { stage: STAGES.AWAIT_ATTRIBUTE });
    const freshSession = getSession(session.chatId);
    const logEntry = {
      ...baseLogFields(freshSession, phone, text),
      orderStatus: 'In Progress',
      notes: 'لا يوجد منتج مطابق في قاعدة البيانات - في انتظار متابعة فريق المتجر',
    };
    const adminNotification =
      `⚠️ عميل محتاج منتج مش موجود في الكتالوج\n` +
      `رقم العميل: ${phone}\n` +
      `الاحتياج: ${buildNeedDescription(freshSession)}\n` +
      `آخر رسالة: ${text}`;
    return {
      reply: `${MESSAGES.noProductFound}\n${MESSAGES.noProductDataDisclaimer}`,
      logEntry,
      adminNotification,
    };
  }

  updateSession(session.chatId, {
    recommendedProduct: product,
    shownProductIds: [...(session.shownProductIds || []), product.id],
    stage: STAGES.RECOMMENDED,
  });

  const logEntry = {
    ...baseLogFields(getSession(session.chatId), phone, text),
    productName: product.name,
    orderStatus: 'In Progress',
    notes: 'تم اقتراح منتج - في انتظار قرار العميل',
  };

  const recommendation = recommendationMessage(product);
  return { reply: recommendation.text, logEntry, variantId: recommendation.variantId };
}

function handleAwaitAttribute(session, text, phone) {
  const switchedCategory = tryDetectCategorySwitch(session, text);
  if (switchedCategory && switchedCategory !== 'offers') {
    updateSession(session.chatId, {
      category: switchedCategory,
      skinType: null,
      hairType: null,
      recommendedProduct: null,
    });
    const refreshed = getSession(session.chatId);
    if (switchedCategory === 'skincare') {
      return { reply: MESSAGES.askSkinType, logEntry: null };
    }
    if (switchedCategory === 'haircare') {
      return { reply: MESSAGES.askHairType, logEntry: null };
    }
    return recommendProduct(refreshed, phone, text);
  }

  if (session.category === 'skincare') {
    const skinType = detectSkinType(text);
    if (!skinType) {
      return { reply: MESSAGES.askSkinType, logEntry: null };
    }
    updateSession(session.chatId, { skinType });
    return recommendProduct(getSession(session.chatId), phone, text);
  }

  if (session.category === 'haircare') {
    const hairType = detectHairType(text);
    if (!hairType) {
      return { reply: MESSAGES.askHairType, logEntry: null };
    }
    updateSession(session.chatId, { hairType });
    return recommendProduct(getSession(session.chatId), phone, text);
  }

  return { reply: MESSAGES.fallback, logEntry: null };
}

function handleRecommended(session, text, phone) {
  const switchedCategory = tryDetectCategorySwitch(session, text);
  if (switchedCategory && switchedCategory !== 'offers') {
    updateSession(session.chatId, {
      category: switchedCategory,
      skinType: null,
      hairType: null,
      recommendedProduct: null,
      stage: STAGES.AWAIT_CATEGORY,
    });
    return handleAwaitCategory(getSession(session.chatId), text, phone);
  }

  if (escalationDetector.isEscalationRequest(text)) {
    return buildEscalationResponse(session, phone, text);
  }

  const intent = detectIntent(text);

  if (intent === INTENT.CONFIRMED) {
    updateSession(session.chatId, { stage: STAGES.AWAIT_ORDER_DETAILS });
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'In Progress',
      notes: 'العميل أبدى رغبة في الشراء - في انتظار الاسم والعنوان',
    };
    return { reply: MESSAGES.askOrderDetails, logEntry };
  }

  if (intent === INTENT.CANCELLED) {
    updateSession(session.chatId, { stage: STAGES.CLOSED });
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'Cancelled',
      notes: 'العميل رفض أو ألغى الطلب',
    };
    return { reply: MESSAGES.orderCancelled, logEntry };
  }

  // Not a purchase decision — check if it's a common question (price/delivery/
  // ingredients/availability) before falling back to a generic filler reply.
  const faqType = faqDetector.detectFaqType(text);
  if (faqType) {
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'In Progress',
      notes: `العميل سأل سؤال (${faqType}) قبل اتخاذ القرار`,
    };
    return { reply: faqDetector.buildFaqAnswer(faqType, session.recommendedProduct), logEntry };
  }

  const logEntry = {
    ...baseLogFields(getSession(session.chatId), phone, text),
    orderStatus: 'In Progress',
    notes: 'العميل لا يزال يسأل أو يقارن',
  };
  return { reply: MESSAGES.stillDeciding, logEntry };
}

function handleAwaitOrderDetails(session, text, phone, senderName) {
  const intent = detectIntent(text);

  if (intent === INTENT.CANCELLED) {
    updateSession(session.chatId, { stage: STAGES.CLOSED });
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'Cancelled',
      notes: 'العميل ألغى الطلب أثناء تجميع بيانات التوصيل',
    };
    return { reply: MESSAGES.orderCancelled, logEntry };
  }

  if (escalationDetector.isEscalationRequest(text)) {
    return buildEscalationResponse(session, phone, text);
  }

  // A question here ("هيوصل امتى؟") isn't address data — answer it and stay
  // in this stage instead of misreading the question itself as the address.
  const faqType = faqDetector.detectFaqType(text);
  if (faqType) {
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'In Progress',
      notes: `العميل سأل سؤال (${faqType}) أثناء تجميع بيانات التوصيل`,
    };
    return { reply: faqDetector.buildFaqAnswer(faqType, session.recommendedProduct), logEntry };
  }

  const customerName = session.customerName || senderName || '';
  const deliveryAddress = text.trim();

  updateSession(session.chatId, {
    customerName,
    deliveryAddress,
    stage: STAGES.AWAIT_ORDER_CONFIRMATION,
    orderConfirmationAttempts: 0,
  });

  const logEntry = {
    ...baseLogFields(getSession(session.chatId), phone, text),
    customerName,
    deliveryAddress,
    orderStatus: 'In Progress',
    notes: 'تم استلام بيانات التوصيل - في انتظار تأكيد العميل عليها',
  };

  const productName = session.recommendedProduct ? session.recommendedProduct.name : '';
  return {
    reply: orderConfirmationSummary({ productName, customerName, deliveryAddress }),
    logEntry,
  };
}

const MAX_UNCLEAR_CONFIRMATION_ATTEMPTS = 3;

function handleAwaitOrderConfirmation(session, text, phone) {
  if (escalationDetector.isEscalationRequest(text)) {
    updateSession(session.chatId, { orderConfirmationAttempts: 0 });
    return buildEscalationResponse(session, phone, text);
  }

  // A question here ("مصاريف الشحن كام؟") shouldn't be read as a yes/no answer.
  const faqType = faqDetector.detectFaqType(text);
  if (faqType) {
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'In Progress',
      notes: `العميل سأل سؤال (${faqType}) أثناء تأكيد بيانات الطلب`,
    };
    return { reply: faqDetector.buildFaqAnswer(faqType, session.recommendedProduct), logEntry };
  }

  const confirmation = detectAddressConfirmation(text);

  if (confirmation === INTENT.CONFIRMED) {
    updateSession(session.chatId, { stage: STAGES.CLOSED, orderConfirmationAttempts: 0 });
    const freshSession = getSession(session.chatId);
    const logEntry = {
      ...baseLogFields(freshSession, phone, text),
      orderStatus: 'Completed',
      notes: 'تم تأكيد الطلب والبيانات من العميل',
    };
    const adminNotification =
      `✅ طلب جديد مكتمل!\n` +
      `المنتج: ${freshSession.recommendedProduct ? freshSession.recommendedProduct.name : 'غير محدد'}\n` +
      `الاسم: ${freshSession.customerName || 'غير محدد'}\n` +
      `رقم العميل: ${phone}\n` +
      `العنوان: ${freshSession.deliveryAddress || 'غير محدد'}`;
    return { reply: MESSAGES.orderCompleted, logEntry, adminNotification };
  }

  if (confirmation === INTENT.CANCELLED) {
    updateSession(session.chatId, { stage: STAGES.AWAIT_ORDER_DETAILS, orderConfirmationAttempts: 0 });
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'In Progress',
      notes: 'العميل طلب تصحيح بيانات التوصيل',
    };
    return { reply: MESSAGES.askOrderDetailsAgain, logEntry };
  }

  // UNDECIDED — neither a recognized yes/no nor a question. After repeated
  // unclear replies, don't keep looping forever: hand off to a human instead
  // of showing the same summary a 4th+ time (this is exactly what happened in
  // production — a customer sending casual chit-chat at this step with no
  // way out except stumbling onto an exact keyword).
  const attempts = (session.orderConfirmationAttempts || 0) + 1;

  if (attempts >= MAX_UNCLEAR_CONFIRMATION_ATTEMPTS) {
    updateSession(session.chatId, { orderConfirmationAttempts: 0 });
    const logEntry = {
      ...baseLogFields(getSession(session.chatId), phone, text),
      orderStatus: 'In Progress',
      notes: `تصعيد تلقائي بعد ${attempts} محاولات غير واضحة لتأكيد بيانات الطلب`,
    };
    const adminNotification =
      `🆘 عميل محتاج مساعدة — مش قادر يأكد بيانات الطلب بعد ${attempts} محاولات\n` +
      `رقم العميل: ${phone}\n` +
      `آخر رسالة: ${text}\n` +
      `المرحلة: ${session.stage}`;
    return {
      reply: 'حاسة إن في لخبطة شوية 🌸 هبعتلك حد من فريقنا يتواصل معاكي علشان نتأكد من طلبك صح.',
      logEntry,
      adminNotification,
    };
  }

  // Still under the retry limit — treat this as a possible corrected address
  // (rather than silently re-showing stale data) and show an updated summary.
  const updatedAddress = text.trim();
  updateSession(session.chatId, { deliveryAddress: updatedAddress, orderConfirmationAttempts: attempts });

  const logEntry = {
    ...baseLogFields(getSession(session.chatId), phone, text),
    deliveryAddress: updatedAddress,
    orderStatus: 'In Progress',
    notes: 'العميل حدّث بيانات التوصيل - في انتظار تأكيد جديد',
  };
  const productName = session.recommendedProduct ? session.recommendedProduct.name : '';
  return {
    reply: orderConfirmationSummary({
      productName,
      customerName: session.customerName,
      deliveryAddress: updatedAddress,
    }),
    logEntry,
  };
}

function handleClosed(session, text, phone) {
  updateSession(session.chatId, {
    stage: STAGES.AWAIT_CATEGORY,
    category: null,
    skinType: null,
    hairType: null,
    recommendedProduct: null,
    shownProductIds: [],
    nudgeSentAt: null,
    orderConfirmationAttempts: 0,
  });
  return handleAwaitCategory(getSession(session.chatId), text, phone);
}

// The AI provider only REPHRASES a reply the rule engine already produced —
// it never decides what to say or generates facts itself. This keeps the
// "never invent prices/products" guarantee regardless of AI_PROVIDER, and
// means lead logging (logEntry) always comes from the rule engine, never null.
const REPHRASE_SYSTEM_PROMPT =
  'انتي مساعدة مبيعات مصرية شاطرة وودودة في متجر Beauty Hub October للمستحضرات التجميلية. ' +
  'هيتيجيلك رسالة جاهزة بالمعنى المطلوب بالظبط. مهمتك الوحيدة إنك تعيدي صياغتها بلهجة مصرية ' +
  'عامية طبيعية وودودة أكتر، من غير ما تغيري أي رقم أو سعر أو اسم منتج أو تضيفي أو تشيلي أي ' +
  'معلومة موجودة فيها. ردي بالرسالة المعاد صياغتها بس، من غير أي مقدمة أو شرح إضافي.';

function extractNumbers(text) {
  return (text.match(/\d+/g) || []);
}

// Guards against the AI "helpfully" dropping or altering a price/number while
// rephrasing — if any digit sequence from the original is missing, reject it.
function isSafeRephrase(original, rephrased) {
  return extractNumbers(original).every((n) => rephrased.includes(n));
}

async function tryRephraseWithAi(originalReply) {
  if (config.aiProvider === 'none' || !originalReply) return null;

  try {
    let rephrased = null;
    if (config.aiProvider === 'openai') {
      rephrased = await openaiService.generateReply(REPHRASE_SYSTEM_PROMPT, originalReply);
    } else if (config.aiProvider === 'anthropic') {
      rephrased = await anthropicService.generateReply(REPHRASE_SYSTEM_PROMPT, originalReply);
    }

    if (!rephrased) return null;

    if (!isSafeRephrase(originalReply, rephrased)) {
      logger.warn('AI rephrase altered a number (price/etc) in the reply — using the original rule-based reply instead.');
      return null;
    }

    return rephrased;
  } catch (err) {
    logger.error('AI rephrase failed, using the original rule-based reply.', err);
    return null;
  }
}

function computeRuleBasedReply(session, trimmedText, phone, senderName) {
  if (session.stage === STAGES.NEW) {
    return handleNew(session, trimmedText);
  }

  if (session.stage === STAGES.AWAIT_CATEGORY) {
    return handleAwaitCategory(session, trimmedText, phone);
  }

  if (session.stage === STAGES.AWAIT_ATTRIBUTE) {
    return handleAwaitAttribute(session, trimmedText, phone);
  }

  if (session.stage === STAGES.RECOMMENDED) {
    return handleRecommended(session, trimmedText, phone);
  }

  if (session.stage === STAGES.AWAIT_ORDER_DETAILS) {
    return handleAwaitOrderDetails(session, trimmedText, phone, senderName);
  }

  if (session.stage === STAGES.AWAIT_ORDER_CONFIRMATION) {
    return handleAwaitOrderConfirmation(session, trimmedText, phone);
  }

  if (session.stage === STAGES.CLOSED) {
    return handleClosed(session, trimmedText, phone);
  }

  return { reply: MESSAGES.fallback, logEntry: null };
}

async function handleMessageRules({ chatId, phone, text, senderName }) {
  const session = getSession(chatId);
  const trimmedText = (text || '').trim();

  // Any real message is a re-engagement signal — clear a previously-sent cart
  // recovery nudge so a future idle period can trigger a fresh one.
  if (session.nudgeSentAt) {
    updateSession(chatId, { nudgeSentAt: null });
  }

  const result = computeRuleBasedReply(session, trimmedText, phone, senderName);

  const naturalReply = await tryRephraseWithAi(result.reply);
  if (naturalReply) {
    return {
      reply: naturalReply,
      logEntry: result.logEntry,
      adminNotification: result.adminNotification,
      variantId: result.variantId,
    };
  }

  return result;
}

// Router: 'llm' sends every customer through the free-form Gemini-driven
// agent; 'rules' (default) keeps the proven state machine, except for phone
// numbers explicitly canaried via LLM_AGENT_TEST_CHAT_IDS. Switching
// AGENT_MODE back to 'rules' is an instant rollback if the LLM agent
// misbehaves on real traffic.
async function handleMessage(params) {
  const useLlm = config.agentMode === 'llm' || config.llmAgentTestChatIds.includes(params.phone);
  if (useLlm) {
    return llmAgent.handleMessage(params);
  }
  return handleMessageRules(params);
}

module.exports = { handleMessage };
