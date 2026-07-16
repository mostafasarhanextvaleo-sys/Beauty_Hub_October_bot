const { getSession } = require('./conversationMemory');

const CATEGORY_LABELS_AR = {
  skincare: 'بشرة',
  haircare: 'شعر',
  makeup: 'ميكب',
  bodycare: 'عناية بالجسم',
  offers: 'عروض',
};

const SKIN_TYPE_LABELS_AR = {
  oily: 'دهنية',
  dry: 'جافة',
  combination: 'مختلطة',
  sensitive: 'حساسة',
};

const HAIR_TYPE_LABELS_AR = {
  dry: 'جفاف',
  frizzy: 'هيشان',
  damaged: 'تلف',
  falling: 'تساقط',
  dandruff: 'قشرة',
};

function buildNeedDescription(session) {
  const parts = [];
  if (session.category) parts.push(CATEGORY_LABELS_AR[session.category] || session.category);
  if (session.skinType) parts.push(`بشرة ${SKIN_TYPE_LABELS_AR[session.skinType] || session.skinType}`);
  if (session.hairType) parts.push(`شعر ${HAIR_TYPE_LABELS_AR[session.hairType] || session.hairType}`);
  return parts.join(' - ') || 'غير محدد';
}

function baseLogFields(session, phone, text) {
  return {
    customerName: session.customerName || '',
    customerPhone: phone,
    customerMessage: text,
    productName: session.recommendedProduct ? session.recommendedProduct.name : '',
    customerNeed: buildNeedDescription(session),
    deliveryAddress: session.deliveryAddress || '',
  };
}

// Shared across every stage/engine that checks for it: a customer explicitly
// asking for a human is answered with reassurance and pings the admin (if
// ADMIN_WHATSAPP_NUMBER is configured) instead of being silently swallowed by
// whatever the current stage would otherwise do with the text (e.g. treating
// it as an address, or repeating a confirmation prompt forever).
function buildEscalationResponse(session, phone, text) {
  const logEntry = {
    ...baseLogFields(getSession(session.chatId), phone, text),
    orderStatus: 'In Progress',
    notes: 'العميل طلب التحدث مع خدمة العملاء',
  };
  const adminNotification =
    `🆘 عميل طالب يتكلم مع حد من خدمة العملاء\n` +
    `رقم العميل: ${phone}\n` +
    `آخر رسالة: ${text}\n` +
    `المرحلة: ${session.stage}`;
  return {
    reply: 'تمام 🌸 تقدر تتواصل مع خدمة العملاء الحقيقيين مكالمة أو واتساب على الرقم ده: 01018990503',
    logEntry,
    adminNotification,
  };
}

module.exports = {
  CATEGORY_LABELS_AR,
  SKIN_TYPE_LABELS_AR,
  HAIR_TYPE_LABELS_AR,
  buildNeedDescription,
  baseLogFields,
  buildEscalationResponse,
};
