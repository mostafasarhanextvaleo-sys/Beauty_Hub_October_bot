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
};

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

function getMediaNoCaptionReply(messageType) {
  const ack = MEDIA_ACKNOWLEDGMENTS[messageType];
  if (ack) {
    return `${ack}\n${MEDIA_DESCRIBE_PROMPT}`;
  }
  return MESSAGES.fallback;
}

function getMediaCaptionPrefix(messageType) {
  const ack = MEDIA_ACKNOWLEDGMENTS[messageType];
  return ack ? `${ack}\n` : '';
}

function orderConfirmationSummary({ productName, customerName, deliveryAddress }) {
  return (
    'تمام 🌸 خليني أتأكد من البيانات:\n' +
    `المنتج: ${productName || 'غير محدد'}\n` +
    `الاسم: ${customerName || 'غير محدد'}\n` +
    `العنوان: ${deliveryAddress || 'غير محدد'}\n` +
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
