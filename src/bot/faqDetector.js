const { containsAny } = require('../utils/helpers');

const FAQ_TYPES = {
  PRICE: 'PRICE',
  DELIVERY: 'DELIVERY',
  INGREDIENTS: 'INGREDIENTS',
  AVAILABILITY: 'AVAILABILITY',
  LOCATION: 'LOCATION',
};

const FAQ_KEYWORDS = {
  [FAQ_TYPES.PRICE]: ['كام السعر', 'بكام', 'السعر كام', 'تمنه كام', 'سعره كام', 'كام تمنه', 'ثمنه كام'],
  [FAQ_TYPES.DELIVERY]: [
    'التوصيل',
    'الشحن',
    'بتوصلوا',
    'هيوصل امتى',
    'بتوصل امتى',
    'مصاريف الشحن',
    'مدة التوصيل',
    'امتي', // bare "when" — only checked at order-related stages, where a
            // follow-up right after a price/product question is almost
            // always "when will it arrive", not something else.
  ],
  [FAQ_TYPES.INGREDIENTS]: ['المكونات', 'مكوناته', 'فيه مواد ايه', 'مصنوع من ايه', 'مكونات المنتج'],
  [FAQ_TYPES.AVAILABILITY]: [
    'متوفر الوان',
    'الوان تانية',
    'مقاسات تانية',
    'لسه متوفر',
    'الوان ايه متاحة',
    'عندك',
    'عندكم',
    'فيه عندكم',
    'بتبيعوا',
  ],
  // Deliberately NOT matching bare "العنوان" — that word is also how a
  // customer starts giving their OWN delivery address ("العنوان: ..."), so
  // only the clearer "where are you located" phrasings are included here.
  [FAQ_TYPES.LOCATION]: ['مكانكم فين', 'انتوا فين', 'المحل فين', 'الفرع فين', 'فرعكم فين', 'عنوانكم فين', 'موقعكم فين'],
};

// Checked before the generic "still deciding" fallback so common questions
// (price/delivery/ingredients/availability) get an honest, specific answer
// instead of a non-answer — never inventing facts the system doesn't have.
function detectFaqType(text) {
  for (const [type, keywords] of Object.entries(FAQ_KEYWORDS)) {
    if (containsAny(text, keywords)) return type;
  }
  return null;
}

function buildFaqAnswer(type, product) {
  if (type === FAQ_TYPES.PRICE) {
    if (product && product.price) {
      return `السعر: ${product.price} 🌸 تحبي أحجزهولك؟`;
    }
    return 'مش عايزة أضمنلك سعر غلط، حد من فريق المتجر هيأكدلك السعر بالظبط قريب 🌸';
  }

  if (type === FAQ_TYPES.DELIVERY) {
    return 'التفاصيل الدقيقة بتاعة التوصيل (المدة والمصاريف) هيأكدهملك فريق المتجر بالظبط حسب منطقتك 🌸';
  }

  if (type === FAQ_TYPES.INGREDIENTS) {
    if (product && product.description) {
      return `${product.description}\nلو حابة تفاصيل أكتر عن المكونات، فريق المتجر هيقدر يفيدك أكتر 🌸`;
    }
    return 'تفاصيل المكونات الدقيقة هيأكدهملك فريق المتجر 🌸';
  }

  if (type === FAQ_TYPES.AVAILABILITY) {
    return 'التوفر بالظبط (المنتج ده أو أي منتج تاني) هيأكدهولك فريق المتجر قريب 🌸';
  }

  if (type === FAQ_TYPES.LOCATION) {
    return 'عنوان الفرع بالظبط هيبعتهولك فريق المتجر دلوقتي 🌸';
  }

  return null;
}

module.exports = { FAQ_TYPES, detectFaqType, buildFaqAnswer };
