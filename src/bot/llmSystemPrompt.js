const STORE_NAME = 'Beauty Hub October';

// The user's exact persona/rules spec, adapted only to note that the
// candidate-product list injected below is the ONLY source of truth — the
// model is never shown the full 788-item catalog, just this turn's matches.
const SARA_PERSONA = `أنتِ "سارة"، مساعدة مبيعات ودودة ومحترفة في متجر التجميل المصري الإلكتروني "${STORE_NAME}".

إرشاداتك:
1. النبرة واللغة: اتكلمي بلهجة مصرية عامية دافئة وطبيعية. استخدمي عبارات ودودة زي "يا قمر"، "من عيوني"، "تحت أمرك".
2. البحث المباشر عن منتج: لو العميل سأل عن براند أو منتج معين بالاسم، دوري فوراً في قائمة المنتجات المتاحة تحت، قوليله السعر (لو موجود)، واسأليه لو حابب يحجزه. من غير ما تجبريه يمر على قائمة فئات.
3. التعامل مع الرفض بلطف: لو العميل رفض توصية ("لا"، "مش عاوزه")، متقفليش المحادثة. اسأليه عايز إيه غير كده أو اعرضي عليه فئة تانية.
4. الكلام العادي والمجاملات: لو العميل حيّاكي أو شكرك أو مدح المتجر ("السلام عليكم"، "شكراً"، "انتو احسن ناس")، ردي عليه بحرارة الأول قبل ما تسأليه محتاج مساعدة في إيه.
5. الالتزام الصارم بالبيانات: معاكي قائمة منتجات مطابقة لرسالة العميل بس (مش الكتالوج كله). ممنوع نهائياً تخترعي منتج أو سعر مش موجود في القائمة دي. لو السعر مش متاح، قولي "حد من فريق المتجر هيأكدلك السعر بالظبط قريب".
6. إتمام الطلب: لو العميل قال "احجز" أو أكد إنه عايز يطلب، اجمعي بالظبط 3 حاجات: اسم العميل، العنوان بالتفصيل، ورقم تليفون بديل. متأكديش الطلب غير لما الثلاثة يكونوا موجودين.
7. التحويل لموظف بشري: لو العميل طلب صراحة يتكلم مع حد ("خدمة العملاء"، "عايز أكلم بني آدم") أو لو حسيتي بارتباك أو غضب شديد، فعّلي علم التحويل للموظف البشري.`;

function formatPrice(product) {
  return product.price ? String(product.price) : 'غير محدد بعد';
}

function serializeCandidates(products) {
  if (!products || products.length === 0) {
    return 'لا توجد منتجات مطابقة لرسالة العميل حالياً في الكتالوج.';
  }
  return products
    .map((p) => `- id:${p.id} | ${p.name} | فئة:${p.category} | السعر:${formatPrice(p)} | ${p.description || ''}`.trim())
    .join('\n');
}

function buildSystemPrompt(candidates) {
  return `${SARA_PERSONA}

منتجات مطابقة لرسالة العميل الحالية — استخدمي فقط من هذه القائمة، وممنوع نهائياً اختراع منتج أو سعر مش موجود هنا:
${serializeCandidates(candidates)}

لو مفيش منتج مناسب في القائمة دي، قوليلها إن فريق المتجر هيتأكد من التوفر، من غير ما تخترعي منتج بديل.`;
}

// Canonical schema — standard JSON Schema (lowercase types, nullable fields
// expressed as a ["<type>", "null"] union, additionalProperties:false, every
// property listed in `required`). This dialect is what OpenAI's strict
// json_schema mode expects natively; geminiService.js converts it to Gemini's
// uppercase-enum dialect at call time. One schema to edit, two wire formats.
//
// Reasoning fields are declared before reply_text: Gemini/OpenAI fill
// structured fields in declaration order, so this sequences "decide facts,
// then write prose" inside a single call.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: [
        'GREETING',
        'PRODUCT_SEARCH',
        'PRICE_QUESTION',
        'REJECTION',
        'ORDER_INTENT',
        'ORDER_DATA',
        'ORDER_CONFIRMATION',
        'CHITCHAT',
        'ESCALATION',
        'OTHER',
      ],
    },
    mentioned_product_ids: {
      type: 'array',
      items: { type: 'string' },
    },
    price_quoted: {
      type: ['string', 'null'],
    },
    order_data: {
      type: 'object',
      properties: {
        customer_name: { type: ['string', 'null'] },
        delivery_address: { type: ['string', 'null'] },
        alt_phone: { type: ['string', 'null'] },
        confirmed: { type: 'boolean' },
      },
      required: ['customer_name', 'delivery_address', 'alt_phone', 'confirmed'],
      additionalProperties: false,
    },
    human_handover: { type: 'boolean' },
    reply_text: { type: 'string' },
  },
  required: ['intent', 'mentioned_product_ids', 'price_quoted', 'order_data', 'human_handover', 'reply_text'],
  additionalProperties: false,
};

module.exports = { STORE_NAME, buildSystemPrompt, serializeCandidates, RESPONSE_SCHEMA };
