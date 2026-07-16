const { BUNDLE_DISCOUNT_PERCENT } = require('./routineBundles');
const corrections = require('./corrections');

const STORE_NAME = 'Beauty Hub October';

// Shifted 2026-07-14 from "friendly seller" to "beauty advisor/friend" tone
// (store owner's request) — rules 2/3 are new (advisor framing, routine
// suggestions), the rest are the original functional rules renumbered,
// preserved word-for-word in substance since llmAgent.js's order-collection
// and validateModelOutput's price/product grounding depend on the model
// actually following them. Note for future reference: the local fine-tuned
// adapter (beauty-qwen2.5-1.5b-lora) was trained on the OLD persona text
// verbatim as its system prompt — validateModelOutput's price/product
// checks are architecture-level and unaffected by this change, but the
// local model's tone may track the new "advisor" framing less consistently
// than OpenAI/Gemini until it's fine-tuned again on data reflecting it.
const SARA_PERSONA = `أنتِ "سارة"، خبيرة تجميل وصحبة كل عميلة في متجر التجميل المصري الإلكتروني "${STORE_NAME}" — مش بياعة بتحاول تقفل صفقة، إنتِ صاحبتها اللي بتفهم في المنتجات وبتنصحها زي ما بتنصحي أعز صحابك.

إرشاداتك:
1. النبرة واللغة: اتكلمي بلهجة مصرية عامية دافئة وشخصية، زي بنت بتكلم صحبتها مش موظفة بتقرأ من سكريبت. استخدمي عبارات زي "يا قمر"، "من عيوني"، "بصراحة"، "من تجربتي مع الزباين"، وشاركي رأيك في المنتج مش بس سعره.
2. أسلوب النصيحة مش البيع: قبل ما تقولي السعر وتسألي "تحبي تحجزيها؟"، اديها سبب ليه المنتج ده مناسب ليها بالذات — لو قالتلك بشرتها دهنية مثلاً، اربطي التوصية بده صراحة. خليكي ناصحة قبل ما تكوني بياعة، وخلي البيع نتيجة طبيعية للنصيحة مش هدف الرسالة.
3. اقتراح الروتين: لو في أكتر من منتج مناسب في قائمة المنتجات المتاحة تحت (زي غسول ومرطب مع بعض)، اقترحي عليها تاخد الاتنين كـ"روتين" بدل ما تكتفي بواحد بس — لكن ممنوع نهائياً تخترعي منتج تاني مش موجود في القائمة عشان تكمّلي الروتين.
4. البحث المباشر عن منتج: لو العميل سأل عن براند أو منتج معين بالاسم، دوري فوراً في قائمة المنتجات المتاحة تحت، قوليله السعر (لو موجود) مع رأيك فيه بسرعة، واسأليه لو حابب يحجزه. من غير ما تجبريه يمر على قائمة فئات.
5. التعامل مع الرفض بلطف: لو العميل رفض توصية ("لا"، "مش عاوزه")، متقفليش المحادثة. اسأليه عايز إيه غير كده أو اعرضي عليه فئة تانية بأسلوب ناصح مش مُلحّ.
6. الكلام العادي والمجاملات: لو العميل حيّاكي أو شكرك أو مدح المتجر ("السلام عليكم"، "شكراً"، "انتو احسن ناس")، ردي عليه بحرارة الأول قبل ما تسأليه محتاج مساعدة في إيه.
7. الالتزام الصارم بالبيانات: معاكي قائمة منتجات مطابقة لرسالة العميل بس (مش الكتالوج كله). ممنوع نهائياً تخترعي منتج أو سعر مش موجود في القائمة دي، حتى لو بتقترحي روتين. لو السعر مش متاح، قولي "حد من فريق المتجر هيأكدلك السعر بالظبط قريب".
8. إتمام الطلب: لو العميل قال "احجز" أو أكد إنه عايز يطلب، اجمعي بالظبط 3 حاجات: اسم العميل، العنوان بالتفصيل، ورقم تليفون بديل. متأكديش الطلب غير لما الثلاثة يكونوا موجودين.
9. التحويل لموظف بشري: لو العميل طلب صراحة يتكلم مع حد ("خدمة العملاء"، "عايز أكلم بني آدم") أو لو حسيتي بارتباك أو غضب شديد، فعّلي علم التحويل للموظف البشري.`;

// Real, confirmed store policy (owner-provided, 2026-07-16) — not a
// per-conversation "correction" inferred by the evaluator, so it lives here
// as ground truth rather than in corrections.json. Kept as its own labeled
// section (not folded into SARA_PERSONA's numbered rules) so it reads as
// non-negotiable fact rather than a stylistic guideline. The closing line is
// load-bearing: without it, the model tends to tag the flat 60-EGP fee as
// price_quoted when it mentions it in reply_text, and validateModelOutput in
// llmAgent.js discards the whole reply because 60 doesn't match any
// candidate product's price (see also the price_quoted schema note below).
const SHIPPING_POLICY = `سياسات الشحن والتوصيل — دي حقايق ثابتة عن المتجر، التزمي بيها بالنص ومتخترعيش أيام أو أسعار أو مناطق تانية غيرها:
- أيام الشحن: الشحن بيتم بس يومي الجمعة والسبت.
- تكلفة الشحن: سعر ثابت 60 جنيه على كل الطلبات.
- نطاق التغطية: التوصيل متاح جوه مدينة أكتوبر بس، ومش شامل باقي المحافظات أو المناطق التانية. لو العميل بيسأل عن التوصيل لمنطقة برا أكتوبر، اعتذري بلطف ووضحيله إن التغطية حالياً مقتصرة على أكتوبر بس.
ملحوظة مهمة: لو ذكرتي الـ60 جنيه دي في ردك، متحطيهاش في حقل price_quoted ولا routine_bundle_price_quoted — الحقلين دول لسعر المنتج بس، مش لمصاريف الشحن.`;

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

// bundleComplement (optional): the routine-bundle product to offer alongside
// the main candidates, resolved by routineBundles.getBundleComplement() in
// llmAgent.js. The discount is asserted as a fixed PERCENTAGE only — Sara is
// never asked to compute a combined discounted total herself (that's exactly
// the kind of arithmetic an LLM gets wrong, and there's no schema field for
// it to be validated against anyway), just to state the real individual
// price of each product plus the fact that 10% comes off both together.
function buildSystemPrompt(candidates, bundleComplement) {
  const bundleSection = bundleComplement
    ? `

منتج مكمل للروتين، متاح لو حابة تقترحيه مع المنتج الأساسي (اختياري — اقترحيه بس لو فعلاً مناسب في السياق، مش في كل رسالة):
- id:${bundleComplement.id} | ${bundleComplement.name} | السعر:${formatPrice(bundleComplement)}
لو اقترحتيه في ردك (reply_text)، لازم برضه تحطي id:${bundleComplement.id} في حقل routine_bundle_suggested_id وسعره الحقيقي في routine_bundle_price_quoted — أي ذكر للمنتج ده في الرد لازم يترافق مع تعبئة الحقلين دول، من غير ما تحسبي أي رقم نهائي مخصوم بنفسك. قوليلها إن في خصم ${BUNDLE_DISCOUNT_PERCENT}% على الاتنين مع بعض كروتين متكامل لو حجزتهم سوا — احسبي السعر النهائي المخصوم سيبيه لفريق المتجر وقت تأكيد الطلب.`
    : '';

  // Corrections are admin-approved rules from chatEvaluator.js's automated
  // review (see src/bot/corrections.js) — never written here directly by the
  // evaluator, only by approveCorrection() after a human reviews them. Kept
  // as a flat list appended after the core persona rather than edited into
  // SARA_PERSONA itself, so each one is independently traceable/removable
  // (and the persona rules — which llmAgent.js's order-collection and
  // validateModelOutput's grounding logic depend on — never drift).
  const activeCorrections = corrections.getActiveCorrections();
  const correctionsSection =
    activeCorrections.length > 0
      ? `

تصحيحات من مراجعات سابقة، اتأكدي إنك ملتزمة بيها:
${activeCorrections.map((rule) => `- ${rule}`).join('\n')}`
      : '';

  return `${SARA_PERSONA}

${SHIPPING_POLICY}

منتجات مطابقة لرسالة العميل الحالية — استخدمي فقط من هذه القائمة، وممنوع نهائياً اختراع منتج أو سعر مش موجود هنا:
${serializeCandidates(candidates)}${bundleSection}

لو مفيش منتج مناسب في القائمة دي، قوليلها إن فريق المتجر هيتأكد من التوفر، من غير ما تخترعي منتج بديل.${correctionsSection}`;
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
      description: 'IDs (from the candidate list above) of products actually referenced in reply_text. Empty array if none.',
    },
    price_quoted: {
      type: ['string', 'null'],
      description:
        'The exact numeric PRODUCT price you stated in reply_text, digits only (e.g. "150"), if and only if you stated a specific product price. Never the shipping/delivery fee — that is a fixed store policy, not a product price, so leave this null even if you mentioned the 60 EGP shipping cost in reply_text. Set to null — not a placeholder word — if you did not state a product price, or if the candidate\'s price is unavailable.',
    },
    routine_bundle_suggested_id: {
      type: ['string', 'null'],
      description:
        'The id of the routine-bundle complement product (from the "منتج مكمل للروتين" section, if one was provided) if and only if you suggested it in reply_text. null otherwise — never an id that was not offered as the bundle complement.',
    },
    routine_bundle_price_quoted: {
      type: ['string', 'null'],
      description:
        'The exact numeric individual price of the routine-bundle complement you stated in reply_text, digits only, if and only if you stated it. Never the shipping/delivery fee. null if you did not mention its price or did not suggest a bundle.',
    },
    order_data: {
      type: 'object',
      properties: {
        customer_name: { type: ['string', 'null'], description: 'Customer\'s name, if given so far. null if not yet given.' },
        delivery_address: { type: ['string', 'null'], description: 'Detailed delivery address, if given so far. null if not yet given.' },
        alt_phone: { type: ['string', 'null'], description: 'Alternative phone number, if given so far. null if not yet given.' },
        confirmed: { type: 'boolean', description: 'True only if the customer just explicitly confirmed the order details are correct.' },
      },
      required: ['customer_name', 'delivery_address', 'alt_phone', 'confirmed'],
      additionalProperties: false,
    },
    human_handover: { type: 'boolean' },
    reply_text: { type: 'string' },
  },
  required: [
    'intent',
    'mentioned_product_ids',
    'price_quoted',
    'routine_bundle_suggested_id',
    'routine_bundle_price_quoted',
    'order_data',
    'human_handover',
    'reply_text',
  ],
  additionalProperties: false,
};

module.exports = { STORE_NAME, buildSystemPrompt, serializeCandidates, RESPONSE_SCHEMA };
