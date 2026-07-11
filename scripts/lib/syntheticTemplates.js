// Scripted (non-LLM) customer-message templates for synthetic training-data
// generation. Deliberately NOT LLM-generated on the customer side — keeps the
// only AI-generated part of each example the teacher model's *label*, and
// keeps this fully deterministic/controllable/free to run repeatedly.
//
// Every template pulls real names/prices/categories from the live catalog
// (training-data/catalog.jsonl) so generated turns are grounded in what the
// bot can actually recommend.

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sample(arr, n) {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

const CATEGORIES = ['skincare', 'haircare', 'makeup', 'bodycare'];

const NEED_PHRASES = {
  skincare: ['بشرة دهنية', 'بشرة جافة', 'بشرة حساسة', 'بشرة مختلطة', 'تفتيح البشرة', 'حب الشباب'],
  haircare: ['شعر جاف', 'شعر هايش', 'تساقط الشعر', 'قشرة الشعر', 'شعر تالف', 'لمعان الشعر'],
  makeup: ['مكياج سهرة', 'فاونديشن مناسب لبشرتي', 'روج مات', 'مكياج طبيعي للنهار'],
  bodycare: ['ترطيب الجسم', 'رائحة حلوة', 'تفتيح الجسم', 'عناية باليدين'],
};

const FAKE_NAMES = ['أحمد سامي', 'منى عبد الله', 'كريم حسن', 'ياسمين طارق', 'محمود عزت', 'هبة الله سيد', 'عمر فتحي', 'نور الهدى'];
const FAKE_AREAS = ['المعادي', 'مدينة نصر', 'الشيخ زايد', '6 أكتوبر - الحي المتميز', 'فيصل', 'الهرم', 'مصر الجديدة', 'التجمع الخامس'];

let fakePhoneCounter = 100000;
function fakePhone() {
  fakePhoneCounter += 1;
  return `2010${String(fakePhoneCounter).padStart(7, '0')}`;
}

function loadCatalogByCategory(catalog) {
  const byCategory = {};
  CATEGORIES.forEach((c) => {
    byCategory[c] = catalog.filter((p) => p.category === c && p.inStock !== false);
  });
  return byCategory;
}

// --- Template generators — each returns { turns: [string,...], category } ---

function specificProductTemplates(byCategory) {
  const conversations = [];
  CATEGORIES.forEach((cat) => {
    const products = sample(byCategory[cat], Math.min(50, byCategory[cat].length));
    products.forEach((p) => {
      const opener = pick([
        `بكام سعر ${p.name}؟`,
        `عندكم ${p.name}؟`,
        `عايزة أعرف تفاصيل عن ${p.name}`,
        `ال${p.name} ده مناسب ليا؟`,
      ]);
      conversations.push({ turns: [opener], category: `specific_product_${cat}` });
    });
  });
  return conversations;
}

function productSearchTemplates(byCategory) {
  const conversations = [];
  CATEGORIES.forEach((cat) => {
    for (let i = 0; i < 100; i++) {
      const need = pick(NEED_PHRASES[cat]);
      const opener = pick([
        `محتاجة حاجة كويسة لـ ${need}`,
        `عندك حاجة مناسبة لـ ${need}؟`,
        `ايه أحسن حاجة عندكم لـ ${need}`,
      ]);
      const followUp = pick([
        'الأرخص فيهم إيه؟',
        'وبكام السعر؟',
        'ده متوفر دلوقتي؟',
        'في حاجة تانية زيها؟',
      ]);
      conversations.push({ turns: [opener, followUp], category: `product_search_${cat}` });
    }
  });
  return conversations;
}

function fullOrderFlowTemplates(byCategory) {
  const conversations = [];
  const allProducts = CATEGORIES.flatMap((c) => byCategory[c]);
  const products = sample(allProducts, Math.min(100, allProducts.length));
  products.forEach((p) => {
    const name = pick(FAKE_NAMES);
    const area = pick(FAKE_AREAS);
    const altPhone = fakePhone();
    conversations.push({
      turns: [
        `عايزة ${p.name}`,
        'تمام، احجزيلي الأوردر',
        `العنوان ${area}, ورقم تاني ${altPhone}`,
        `اسمي ${name}`,
        'أيوه, أكدي الطلب',
      ],
      category: 'full_order_flow',
    });
  });
  return conversations;
}

function rejectionTemplates(byCategory) {
  const conversations = [];
  CATEGORIES.forEach((cat) => {
    for (let i = 0; i < Math.ceil(75 / CATEGORIES.length); i++) {
      const need = pick(NEED_PHRASES[cat]);
      conversations.push({
        turns: [`عايزة حاجة لـ ${need}`, pick(['لأ, مش عايزة ده', 'مش ده اللي أنا بدور عليه', 'في حاجة تانية؟'])],
        category: 'rejection',
      });
    }
  });
  return conversations;
}

// Deliberately NOT explicit escalation keywords (those are caught
// deterministically before the model ever sees them in production — see
// escalationDetector.js). These test the model's own judgment of when
// frustration/confusion warrants a human handover, which is exactly the
// production bug (spurious/missing human_handover) this dataset targets.
const ESCALATION_STYLE_MESSAGES = [
  'مش فاهمة حاجة خالص من كل ده, مش عارفه اختار',
  'أنا لخبطت خالص, ممكن حد يساعدني بجد؟',
  'الردود مش واضحة ليا خالص, مش عارفة أكمل',
  'أنا زعلانة من الخدمة, ده مش المفروض يحصل',
  'حاولت أطلب 3 مرات ومش عارفة أكمل الأوردر',
];

function escalationTemplates() {
  return ESCALATION_STYLE_MESSAGES.concat(
    Array.from({ length: 95 - ESCALATION_STYLE_MESSAGES.length }, () => pick(ESCALATION_STYLE_MESSAGES))
  ).map((msg) => ({ turns: [msg], category: 'escalation' }));
}

function chitchatTemplates() {
  const conversations = [];
  const greetings = ['السلام عليكم', 'مساء الخير', 'ازيكم يا بشمهندسين', 'أهلاً بيكم'];
  const thanks = ['شكراً جداً', 'تمام كده, ربنا يكرمك', 'الله يخليك', 'حلو أوي, متشكرة'];
  for (let i = 0; i < 75; i++) {
    conversations.push({ turns: [pick(greetings), pick(thanks)], category: 'chitchat' });
  }
  return conversations;
}

function edgeCaseTemplates() {
  const outOfDomain = [
    'الجو النهاردة عامل ازاي؟',
    'عندك نصيحة في الأكل الصحي؟',
    'مين أحسن فريق كورة في مصر؟',
  ];
  const unavailable = [
    'عندكم بروداكت ماركة كذا؟ (مش موجودة عندكم أصلاً)',
    'في حاجة لعلاج الصلع النهائي؟',
    'عندكم أدوية تخسيس؟',
  ];
  const conversations = [];
  for (let i = 0; i < 25; i++) {
    conversations.push({ turns: [pick(outOfDomain), 'تمام, حاجة تانية بس'], category: 'edge_case_off_topic' });
  }
  for (let i = 0; i < 25; i++) {
    conversations.push({ turns: [pick(unavailable), 'مفيش حاجة قريبة منها؟'], category: 'edge_case_unavailable' });
  }
  return conversations;
}

function buildConversationPlans(catalog) {
  const byCategory = loadCatalogByCategory(catalog);
  return [
    ...specificProductTemplates(byCategory),
    ...productSearchTemplates(byCategory),
    ...fullOrderFlowTemplates(byCategory),
    ...rejectionTemplates(byCategory),
    ...escalationTemplates(),
    ...chitchatTemplates(),
    ...edgeCaseTemplates(),
  ];
}

module.exports = { buildConversationPlans };
