const { WEBSITE_URL } = require('./llmSystemPrompt');

const STORE_NAME = 'Beauty Hub October';

const MESSAGES = {
  greeting:
    `أهلاً بيكي في ${STORE_NAME} 🌸\n` +
    'تحبي أساعدك في حاجة للبشرة ولا الشعر ولا الميكب؟',

  askCategoryAgain:
    'تحبي أساعدك في إيه بالظبط؟ بشرة، شعر، ميكب، عناية بالجسم، ولا عايزة تعرفي عروضنا؟',

  askSkinType: 'تمام، بشرتك دهنية ولا جافة ولا مختلطة؟ عشان أرشحلك حاجة مناسبة.',

  askHairType: 'حلو، المشكلة أكتر في الهيشان ولا التساقط ولا الجفاف ولا القشرة؟',

  offers:
    'عندنا عروض حلوة على مجموعة منتجات دلوقتي 🌸 تحبي أعرفك على عروض البشرة، الشعر، ولا الميكب؟',

  askInterest: 'تحبي أحجزهولك؟',

  askOrderDetails:
    'تمام، تم تسجيل طلبك 🌸\nممكن اسمك والعنوان بالتفصيل ورقم بديل لو متاح؟',

  orderConfirmedNoDetailsYet:
    'تمام، بس محتاجة بس اسمك والعنوان عشان نقفل الطلب صح 🌸',

  askOrderDetailsAgain:
    'تمام، ابعتيلي الاسم والعنوان بالتفصيل تاني عشان أتأكد إنهم مكتوبين صح 🌸',

  orderCompleted:
    'تمام، طلبك اتسجل وهيتم التواصل معاكي لتأكيد التوصيل قريب 🌸 شكراً لثقتك في Beauty Hub October.',

  orderCancelled:
    'ولا يهمك 🌸 لو حبيتي تسألي على حاجة تانية أنا موجودة في أي وقت.',

  outOfStockAtConfirmation:
    'معلش يا قمر، المنتج ده خلص من المخزون قبل ما نقفل طلبك 😔 تحبي أرشحلك بديل مشابه أو منتج تاني؟',

  noProductFound:
    'موجود عندنا اختيارات كتير، بس عشان أرشحلك حاجة مناسبة بجد قوليلي نوع بشرتك أو المشكلة الأساسية عندك.',

  noProductDataDisclaimer:
    'مش عايزة أضمنلك سعر أو توفر غلط، فحد من فريق المتجر هيأكدلك السعر والتوفر بالظبط قريب.',

  stillDeciding:
    'خدي وقتك 🌸 لو حابة تسألي أي سؤال تاني عن المنتج أنا موجودة.',

  fallback:
    'تحت أمرك 🌸 قوليلي محتاجة مساعدة في إيه، بشرة ولا شعر ولا ميكب ولا حاجة تانية؟',

  representativeConfirm:
    'حد من فريقنا هيتواصل معاكي بسرعة لتأكيد السعر والتوفر بالظبط 🌸',

  // 2026-08-09 addition — outgoing product-photo feature. Used only when
  // nothing is pinned/found for the customer's photo request (see
  // llmAgent.js's handleProductImageRequest) — never a made-up product name.
  askWhichProductImage:
    'تحبي أشوفلك صورة أي منتج بالظبط؟ قوليلي اسمه أو احتياجك عشان أرشحلك حاجة الأول 🌸',
};

// 2026-08-09 addition — shown when a real, matched product has no Image URL
// yet in the Products sheet (empty/missing cell). Never a broken link or a
// wrong image — see productMatcher/googleSheetsProducts.js's imageUrl field.
function productImageNotAvailable(productName) {
  return `للأسف صورة "${productName}" لسه بتتظبط عندنا حالياً، هبعتهالك أول ما تكون جاهزة 🌸 تحبي وصف تفاصيل المنتج بدل كده؟`;
}

function productImageReply(productName) {
  return `تمام، دي صورة ${productName} 🌸`;
}

// --- A/B-testable message variants ---
// Each variant has a stable `id` that gets logged to chat_history.log
// (see whatsapp/client.js's logOutgoing call), so confirm-rates per variant
// can be compared later by joining against order outcomes in the Leads sheet.
function pickVariant(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

const GREETING_VARIANTS = [
  {
    id: 'greeting_a',
    text: `أهلاً بيكي في ${STORE_NAME} 🌸\nتحبي أساعدك في حاجة للبشرة ولا الشعر ولا الميكب؟`,
  },
  {
    id: 'greeting_b',
    text: `يا هلا وغلا في ${STORE_NAME} 🌸 قوليلي، محتاجة مساعدة في حاجة للبشرة، الشعر، ولا الميكب؟`,
  },
  {
    id: 'greeting_c',
    text: `أهلاً بيكي 🌸 معاكي فريق ${STORE_NAME}. تحت أمرك، تحبي تسأليني عن إيه؟`,
  },
];

function getGreeting() {
  return pickVariant(GREETING_VARIANTS);
}

const RECOMMENDATION_CTA_VARIANTS = [
  { id: 'cta_a', text: 'تحبي أحجزهولك؟' },
  { id: 'cta_b', text: 'تحبي تاخديه دلوقتي؟' },
  { id: 'cta_c', text: 'إيه رأيك، نأكد الطلب؟' },
];

// Shown when a customer sends media the bot can't read yet (no caption), so
// the conversation never goes silent — always ends with a prompt to describe
// the need in text.
const MEDIA_ACKNOWLEDGMENTS = {
  image: 'استلمت الصورة، بس للأسف لسه مش قادرة أشوف الصور 🌸',
  video: 'استلمت الفيديو، بس للأسف لسه مش قادرة أشوف الفيديوهات 🌸',
  ptt: 'استلمت رسالتك الصوتية، بس للأسف لسه مش قادرة أسمع الصوت 🌸',
  audio: 'استلمت الملف الصوتي، بس للأسف لسه مش قادرة أسمعه 🌸',
};

const MEDIA_DESCRIBE_PROMPT = 'تقدري تكتبيلي طلبك أو توصفيلي المشكلة اللي عندك؟';

// 2026-08-09 fix: this used to be the entire reply regardless of how many
// times in a row a customer sent unreadable media — confirmed live, one
// customer sent 7 photos + 2 videos in a single conversation and got this
// exact sentence every single time, with no path forward. Now degrades
// gracefully with the session's consecutive-miss count (see
// whatsapp/client.js, which owns that counter): 1st miss gets the normal
// ack+prompt below; 2nd gets a proactive offer of the self-browse catalog
// link (WEBSITE_URL already exists for this exact need — see
// llmSystemPrompt.js rule 12 — it just never surfaced here before); 3rd+
// stops repeating anything and hands off to a human instead.
const MEDIA_LINK_OFFER = `تقدري كمان تتصفحي كل المنتجات بالصور بنفسك من هنا وتقوليلي اسم اللي عجبك: ${WEBSITE_URL} 🌸`;

const MEDIA_ESCALATION_REPLY =
  'حاسة إنك محتاجة حد يشوف اللي بعتيه بنفسه 🌸 هبعتلك حد من فريقنا يتواصل معاكِ بسرعة.';

// Shared with whatsapp/client.js (which owns the actual counter and decides
// whether to also fire the admin notification / human-handoff cooldown) so
// the two never drift out of sync on what "escalate" means.
const MEDIA_ESCALATION_THRESHOLD = 3;

function getMediaNoCaptionReply(messageType, consecutiveCount = 1) {
  if (consecutiveCount >= MEDIA_ESCALATION_THRESHOLD) {
    return MEDIA_ESCALATION_REPLY;
  }

  const ack = MEDIA_ACKNOWLEDGMENTS[messageType];
  if (!ack) {
    return MESSAGES.fallback;
  }

  if (consecutiveCount >= 2) {
    return `${ack}\n${MEDIA_LINK_OFFER}`;
  }

  return `${ack}\n${MEDIA_DESCRIBE_PROMPT}`;
}

function getMediaCaptionPrefix(messageType) {
  const ack = MEDIA_ACKNOWLEDGMENTS[messageType];
  return ack ? `${ack}\n` : '';
}

// shippingZone (optional, 2026-08-09): { name, feeEGP } from
// shippingZones.js's matchShippingZone(deliveryAddress) — deterministic, real
// data, never text the model wrote. Omitted entirely (not shown as "غير
// محدد") when null, since a customer whose area doesn't map to a known zone
// yet should be told the team will confirm it, not shown a blank/missing
// line that looks like an oversight. Optional/backward compatible: agent.js's
// two existing call sites (the rules-engine path) don't pass this and are
// completely unaffected.
function orderConfirmationSummary({ productName, customerName, deliveryAddress, shippingZone }) {
  const shippingLine = shippingZone
    ? `الشحن: ${shippingZone.feeEGP} جنيه (${shippingZone.name})\n`
    : '';
  return (
    'تمام 🌸 خليني أتأكد من البيانات:\n' +
    `المنتج: ${productName || 'غير محدد'}\n` +
    `الاسم: ${customerName || 'غير محدد'}\n` +
    `العنوان: ${deliveryAddress || 'غير محدد'}\n` +
    shippingLine +
    'البيانات دي صح؟'
  );
}

function recommendationMessage(product) {
  const benefit =
    product.benefits && product.benefits.length > 0
      ? product.benefits[0]
      : 'يناسب احتياجك';
  const priceLine = product.price
    ? `السعر: ${product.price}.`
    : 'هنأكدلك السعر بالظبط مع فريق المتجر.';
  const cta = pickVariant(RECOMMENDATION_CTA_VARIANTS);
  return {
    text: `${product.name} مناسب ليكي جداً لأنه بيساعد في ${benefit}.\n${priceLine}\n${cta.text}`,
    variantId: cta.id,
  };
}

const CATEGORY_KEYWORDS = {
  skincare: ['بشرة', 'بشرتي', 'وش', 'حبوب', 'تصبغات', 'سكين كير', 'skincare', 'skin'],
  haircare: ['شعر', 'شعري', 'هيشان', 'تساقط شعر', 'قشرة', 'هير كير', 'haircare', 'hair'],
  makeup: ['ميكب', 'مكياج', 'كريم اساس', 'روج', 'ميك اب', 'makeup', 'كونسيلر'],
  bodycare: ['جسم', 'بودي', 'body', 'لوشن', 'ترطيب الجسم', 'سكراب'],
  offers: ['عروض', 'خصومات', 'اوفرز', 'offer', 'خصم', 'عرض'],
};

const SKIN_TYPE_KEYWORDS = {
  oily: ['دهنية', 'دهني', 'oily'],
  dry: ['جافة', 'جاف', 'dry'],
  combination: ['مختلطة', 'مختلط', 'combination'],
  sensitive: ['حساسة', 'حساس', 'sensitive'],
};

const HAIR_TYPE_KEYWORDS = {
  dry: ['جفاف', 'جاف', 'dry'],
  frizzy: ['هيشان', 'هايش', 'frizzy'],
  damaged: ['تالف', 'تلف', 'تقصف', 'damaged'],
  falling: ['تساقط', 'بيقع', 'falling'],
  dandruff: ['قشرة', 'dandruff'],
};

// Word roots rather than exact phrases, so containsAny() also catches natural
// conjugations/suffixes (e.g. "احجز" matches "احجزيه", "احجزها", "احجزيلي"...).
// "تمام" is included because the recommendation CTA sometimes directly asks a
// yes/no question ("تحبي تاخديه دلوقتي؟"), and "تمام" is the single most
// common Egyptian way to answer "yes" to that.
const ORDER_CONFIRM_KEYWORDS = [
  'احجز',
  'هاخد',
  'ابعت',
  'موافق',
  'تمام',
  'اكد الطلب',
  'اكدي الطلب',
  'عايز اطلب',
  'عايزة اطلب',
  'عايزاه',
  'عايزها',
  'اوك',
  'ok',
];

const ORDER_CANCEL_KEYWORDS = [
  'لأ شكرا',
  'لا شكرا',
  'مش عايز',
  'مش عايزة',
  'مش محتاج',
  'مش محتاجة',
  'مش موافق',
  'مش موافقة',
  'مش تمام',
  'كنسل',
  'الغاء الطلب',
  'الغي الطلب',
  'مش هاخده',
  'مش هاخد',
  'لا مش دلوقتي',
];

// Scoped to "cancel an order that's already been confirmed" (session.orderPlaced
// === true in llmAgent.js), so this is deliberately narrower/higher-confidence
// than ORDER_CANCEL_KEYWORDS above: that list also matches generic pre-order
// declines ("لا شكرا", "مش موافق") which are fine to read as "don't want this
// recommendation" but would be dangerous to read as "cancel my placed order" —
// e.g. a customer saying "مش موافقة على السعر ده" about a totally different,
// later product must not cancel an order they already confirmed. Every phrase
// here names the order itself ("الطلب"/"الاوردر") or is an unambiguous
// cancel-verb ("كنسل").
const ORDER_CANCELLATION_REQUEST_KEYWORDS = [
  'كنسل',
  'الغي الطلب',
  'الغي الاوردر',
  'الغاء الطلب',
  'الغاء الاوردر',
  'لغيت الطلب',
  'لغيت الاوردر',
  'وقف الطلب',
  'شيل الطلب',
  'مش عايزة الطلب',
  'مش عايز الطلب',
  // 2026-08-09 additions — confirmed live (chatId 33561512034419@lid): a real
  // customer tried to cancel a confirmed order EIGHT separate times, in
  // natural colloquial phrasing, and NONE of the phrases above matched any of
  // them — every attempt fell through to the general LLM, which had no real
  // way to help and just repeated a canned "contact customer service"
  // deflection with no phone number, no escalation, no actual cancellation.
  // These add the exact real phrasings that were missed: colloquial future
  // tense ("هلغي" = "I'll cancel", not the imperative "الغي" already covered)
  // and "won't receive/take it" framed around the order itself.
  'هلغي الطلب',
  'هلغي الاوردر',
  'مش هستلم الطلب',
  'مش هستلم الاوردر',
  'مش هاخد الطلب',
  'مش هاخده الطلب',
  'مش هاخد الاوردر',
  'مش هاخده الاوردر',
  'رافضة الطلب',
  'رافض الطلب',
  'رافضة الاوردر',
  'رافض الاوردر',
];

// Very short (1-word) yes/no. Must go through containsWord() (whole-word),
// not containsAny() (substring) — "لا" is a substring of "الاسم", so a
// customer typing "الاسم مصطفى..." must not be misread as saying "no".
const SHORT_YES_WORDS = ['صح', 'اه'];
const SHORT_NO_WORDS = ['لا', 'لأ'];

// Dedicated to the "is this order/address data correct?" confirmation step —
// kept separate from ORDER_CONFIRM/CANCEL_KEYWORDS above (which are about
// initial purchase intent) so tuning one never risks the other.
const ADDRESS_CONFIRM_YES_KEYWORDS = ['تمام', 'ايوه', 'أيوه', 'صح كده', 'موافق', 'اه تمام', 'ok', 'اوك'];

const ADDRESS_CONFIRM_NO_KEYWORDS = [
  'لأ شكرا',
  'لا شكرا',
  'مش عايز',
  'مش عايزة',
  'مش محتاج',
  'مش محتاجة',
  'مش موافق',
  'مش موافقة',
  'مش تمام',
  'كنسل',
  'الغاء الطلب',
  'الغي الطلب',
  'غلط',
  'مش صح',
  'عايزة اغير',
  'عايز اغير',
];

module.exports = {
  STORE_NAME,
  MESSAGES,
  recommendationMessage,
  orderConfirmationSummary,
  getGreeting,
  getMediaNoCaptionReply,
  getMediaCaptionPrefix,
  MEDIA_ESCALATION_THRESHOLD,
  productImageNotAvailable,
  productImageReply,
  CATEGORY_KEYWORDS,
  SKIN_TYPE_KEYWORDS,
  HAIR_TYPE_KEYWORDS,
  ORDER_CONFIRM_KEYWORDS,
  ORDER_CANCEL_KEYWORDS,
  ORDER_CANCELLATION_REQUEST_KEYWORDS,
  ADDRESS_CONFIRM_YES_KEYWORDS,
  ADDRESS_CONFIRM_NO_KEYWORDS,
  SHORT_YES_WORDS,
  SHORT_NO_WORDS,
};
