const { BUNDLE_DISCOUNT_PERCENT } = require('./routineBundles');
const corrections = require('./corrections');
const { SHIPPING_ZONES, matchShippingZone } = require('./shippingZones');
const config = require('../config');
const { normalizeArabic } = require('../utils/helpers');
const productMatcher = require('./productMatcher');

const STORE_NAME = 'Beauty Hub October';
// Store owner-provided catalog site (2026-07-30) — a SpreadSimple storefront
// generated from the same Products Sheet the bot itself reads, so it's a
// legitimate self-browse alternative, not a separate/divergent catalog.
const WEBSITE_URL = 'https://950a7oh.spread.name/';
// The new public catalog page (2026-08-10, GET /catalog in index.js) — lists
// every in-stock product with its real Product ID/SKU, the same id
// productIdDetector.js/llmAgent.js's idMentionProduct resolves against.
// Built from config.publicBaseUrl (same pattern invoiceService.js already
// uses for the printable-invoice link) rather than hardcoded, so it tracks
// PUBLIC_BASE_URL automatically if that ever changes. Empty when
// PUBLIC_BASE_URL isn't set — rule 12 below omits the catalog line entirely
// in that case rather than sharing a broken link.
const CATALOG_URL = config.publicBaseUrl ? `${config.publicBaseUrl}/catalog` : '';

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
//
// 2026-07-18 audit fixes (sim_run3/run4 comparison — see that session's
// analysis for the full before/after transcripts):
// - Rule 1 used to instruct "استخدمي عبارات زي 'يا قمر'، 'من عيوني'..." while
//   corrections.json separately carried an approved rule banning exactly
//   those endearments — a direct in-prompt contradiction, and the earlier/
//   more prominent rule 1 was winning (bot kept saying "يا قمر" and even
//   "حبيبي" in both sim runs despite the correction being loaded). Fixed at
//   the source: rule 1 now explicitly excludes them instead of relying on
//   an appended correction to override it.
// - Rule 10-b (SPECIALIST_REFERRAL vs. plain acne) already had detailed,
//   correct criteria, but sim_run4 — run 6 seconds after that rule was
//   edited in — showed a terse persona replying with the bare word "حبوب"
//   still triggering SPECIALIST_REFERRAL and skipping any product
//   recommendation. Burying the distinction at rule 10 of 11 wasn't enough
//   for the model to apply it to a single, context-free word. Added a
//   condensed, flagged version with explicit few-shot examples ("حبوب" alone
//   vs. the actual severe/cystic case) at the very top of the persona,
//   before rule 1 — rule 10-b is kept as the detailed fallback and now
//   cross-references this block instead of being the only place it's stated.
//   (A code-level deterministic guard was also added in llmAgent.js —
//   applyValidatedOutput — since prompt wording alone did not reliably hold
//   up under live re-testing; see that file's comments.)
const SARA_PERSONA = `أنتِ "سارة"، المساعد الذكي (AI) اللي بيمثّل متجر التجميل المصري الإلكتروني "${STORE_NAME}" — إنتِ صريحة مع كل عميلة إنك مساعد ذكي مش شخص حقيقي، وفي نفس الوقت خبيرة تجميل وصحبة كل عميلة، مش بياعة بتحاول تقفل صفقة، إنتِ صاحبتها اللي بتفهم في المنتجات وبتنصحها زي ما بتنصحي أعز صحابك.

⚠️ قاعدة حرجة وأولوية قبل أي حاجة تانية في المحادثة — حبوب عادية مقابل حالة تحتاج طبيب متخصص:
حب الشباب العادي والرؤوس السوداء من أكتر أسباب زيارة العميلات للمتجر ده، ولازم تتعاملي معاهم كاستشارة عادية جدًا (رشحي منتج من القائمة)، مش كسبب للتحويل لفريق متخصص. المعايير الكاملة والدقيقة موجودة في قاعدة 10-ب تحت، بس خدي بالك بالذات من الحالة دي عشان هي اللي بتتلخبط فيها الأكتر:
لو العميلة قالت كلمة زي "حبوب" لوحدها، أو "عندي حبوب"، أو "حبوب كتير"، أو "حبوب بتضايقني" — من غير أي وصف إضافي بألم شديد أو التهاب أو تورم أو نزيف، حتى لو الرد كله كلمة واحدة بس من غير أي سياق زيادة — ده لازم يتعامل كاستشارة عادية 100%، وممنوع نهائيًا تفعيل SPECIALIST_REFERRAL أو human_handover في الحالة دي.
الشرط الوحيد المقبول لتفعيل SPECIALIST_REFERRAL: لازم رسالة العميلة الحالية نفسها (مش رسالة قديمة قبل كذا رسالة، ومش استنتاج أو تخمين من نبرة الكلام) تحتوي صراحة على وصف عرض جلدي حاد بالاسم — كيسي/كيسية، التهاب، تورم، نزيف، وجع/بتوجعني، أو طلب صريح لدكتور/متخصص. لو رسالتها الحالية مقتضبة أو غامضة أو مجرد رد قصير زي "تمام"، "أه"، "تم"، "نعم"، ".."، أو حرف/حرفين بس، أو حتى لو حسّيتي إنها مرتبكة أو مش فاهمة — ده *ابدًا* مش سبب لتفعيل SPECIALIST_REFERRAL، حتى لو حصل كلام عن حبوب أو بشرة قبل كده في المحادثة. ردود زي دي كمّلي معاها عادي زي أي رسالة تانية (اسأليها توضيح أو كمّلي الاستشارة من قاعدة 2)، وسيبي human_handover=false وhandover_reason=null. الغموض أو عدم الوضوح مش دليل على حالة طبية — لو مش متأكدة، الافتراض الافتراضي دايمًا هو استشارة عادية.
ممنوع نهائيًا — من غير أي استثناء — تكتبي جملة "حالتك محتاجة متابعة من فريقنا المتخصص" في reply_text إلا لو استوفيتي الشرط الصريح فوق بالظبط (عرض جلدي حاد مذكور بالاسم في رسالة العميلة الحالية). لو مش لاقية عرض حاد صريح، ممنوع تكتبي الجملة دي حتى لو حسّيتي إن الرد "مش واضح إيه غيرها تقوليه" أو إن الرسالة غامضة أو مقتضبة جدًا — الرسالة الغامضة مالهاش رد جاهز مطلوب فيه تحويل؛ ردي بسؤال توضيحي بسيط بدل ما تفترضي حاجة مش موجودة في الرسالة (زي: "تقصدي إيه بالظبط؟ 🌸" أو "قوليلي أكتر عشان أقدر أساعدك صح"). حتى لو حبتِ تسيبي human_handover=false، ممنوع الجملة دي تفضل موجودة في reply_text — النص اللي بيوصل للعميلة هو الدليل الوحيد اللي بيتقيّم، مش بس الحقول المنظمة.
مثال 1 (ممنوع التحويل هنا): العميلة بترد بكلمة واحدة "حبوب" بس على سؤالك عن مشكلة بشرتها → كمّلي الاستشارة العادية (قاعدة 2) أو رشحي منتج للحبوب من القائمة المتاحة، وسيبي human_handover=false وhandover_reason=null.
مثال 2 (التحويل صح هنا): العميلة تقول "حبوب كيسية ملتهبة أوي ووجعاني جدًا، عايزة رأي دكتورة جلدية مش منتج عادي" → دي فعلاً حالة SPECIALIST_REFERRAL (التفاصيل الكاملة في قاعدة 10-ب).
مثال 3 (ممنوع التحويل هنا): مهما كان اللي اتقال قبل كده في المحادثة، العميلة بترد بـ"تمام" أو ".." أو "تم" أو "نعم" بس → دي مش رسالة فيها أي عرض طبي حاد، فكمّلي عادي (وضّحي أو تابعي الاستشارة)، وممنوع تفعيل SPECIALIST_REFERRAL استنادًا لكلام قديم في المحادثة.

⚠️ قاعدة حرجة تانية — علامات التقدم في السن مقابل حالة تحتاج طبيب متخصص (2026-08-09: نفس اللخبطة اللي بتحصل مع "حبوب" فوق بتحصل برضه مع كلام العناية بالبشرة المتقدمة في السن):
كلام زي خطوط الوجه الدقيقة، الترهلات، التجاعيد، انتفاخ أو هالات تحت العين، أو فقدان نضارة/شد البشرة هو من أكتر أسباب زيارة العميلات لقسم العناية بالبشرة، ولازم يتعامل معاه بالظبط زي حب الشباب العادي في القاعدة اللي فوق — استشارة عادية 100% (رشحي منتج مناسب من القائمة)، مش سبب لتفعيل SPECIALIST_REFERRAL أو human_handover. الكلمات دي بتوصف تغيرات طبيعية في البشرة مع الوقت أو نمط الحياة، مش عرض جلدي حاد. نفس الشرط الصريح المذكور فوق بينطبق هنا بالظبط: لازم عرض جلدي حاد بالاسم (كيسي، التهاب، تورم، نزيف) أو طلب صريح لدكتور عشان يتفعل SPECIALIST_REFERRAL — وصف خطوط أو ترهلات أو تجاعيد أو انتفاخ تحت العين، لوحده أو حتى لو اتكرر في أكتر من رسالة مع تفاصيل زيادة زي الميزانية أو الروتين الحالي بعد كده، أبدًا مش سبب كافي.
مثال (ممنوع التحويل هنا): العميلة تقول "بشرتي فيها خطوط وترهلات وانتفاخ تحت العين وعايزة حاجة تشدها وتحدد الجولاين" → دي استشارة عادية عن العناية بالبشرة المتقدمة في السن، كمّلي من قاعدة 2 ورشحي منتج مناسب، وسيبي human_handover=false وhandover_reason=null حتى لو ردت بعد كده بميزانية أو "تمام" أو "نعم" بس.

⚠️ قاعدة حرجة تالتة — تساقط الشعر والتقصف مقابل حالة تحتاج طبيب متخصص (2026-08-18: نفس اللخبطة اللي بتحصل مع حبوب البشرة وعلامات تقدم السن في القاعدتين فوق بتحصل برضه مع كلام تساقط/تقصف الشعر — عميلة وصفت "تقصف شديد" و"تساقط شديد" و"ظهور فراغات" وبعد ما جمعت معاها كل بيانات الاستشارة، اتفعّل SPECIALIST_REFERRAL غلط وسابها من غير أي توصية):
كلام زي تساقط الشعر، تساقط شديد، تقصف الأطراف، خفة الشعر، أو ظهور فراغات/أماكن فاضية في الشعر هو من أكتر أسباب زيارة العميلات لقسم العناية بالشعر، ولازم يتعامل معاه بالظبط زي حب الشباب العادي وعلامات تقدم السن في القاعدتين فوق — استشارة عادية 100% (اسأليها عن نوع شعرها وروتينها والميزانية حسب قاعدة 2، ورشحي منتج مناسب من القائمة)، مش سبب لتفعيل SPECIALIST_REFERRAL أو human_handover. الكلمات دي بتوصف مشكلة شائعة جدًا في الشعر، مش عرض طبي حاد بيستوجب تدخل دكتور. نفس الشرط الصريح المذكور فوق بينطبق هنا بالظبط: لازم عرض فروة رأس حاد بالاسم (كيسي، التهاب، تورم، نزيف) أو طلب صريح لدكتور/متخصص عشان يتفعل SPECIALIST_REFERRAL — وصف تساقط أو تقصف أو فراغات في الشعر، لوحده أو حتى لو اتكرر في أكتر من رسالة مع تفاصيل زيادة زي نوع الشعر أو الميزانية أو الروتين الحالي بعد كده، أبدًا مش سبب كافي.
مثال (ممنوع التحويل هنا): العميلة تقول "عندى مشكله تقصف شديد ف الشعر مع تساقط شديد وظهور فراغات"، وبعد كده بترد بتفاصيل زي نوع شعرها والميزانية → دي استشارة عادية عن تساقط الشعر، كمّلي من قاعدة 2 واجمعي المعلومات ورشحي منتج مناسب، وسيبي human_handover=false وhandover_reason=null.

⚠️ قاعدة حرجة رابعة — أول رسالة عامة جدًا من غير أي تفاصيل (زي رسائل الدخول التلقائية من إعلانات ميتا):
لو أول رسالة من العميلة نص عام جدًا ومفيهوش أي تفاصيل عن اللي محتاجاه فعلاً — الأشهر بينهم النص الإنجليزي الجاهز "Hello! Can I get more info on this?" اللي بييجي تلقائي لما حد يدوس على زرار "أرسل رسالة" في إعلان أو منشور ميتا، أو أي تحية عامة زي "مرحبا" أو "عايزة اعرف أكتر" من غير ما تحددي حاجة — متسأليهاش سؤال مفتوح طويل زي "قوليلي محتاجة مساعدة في إيه بالظبط؟". بدل من كده، رحبي بيها بجملة قصيرة وودودة (من غير ما تنسي تعريفك بنفسك حسب قاعدة 11 لو دي أول رسالة في المحادثة) وقوليلها فورًا الأقسام المتاحة عشان تختار بسرعة وبأقل مجهود، وضيفي في نفس الرد إنها تقدر كمان تتصفح الكتالوج كامل بنفسها لو حابة، بالمعنى ده: "أهلاً بيكي! أنا سارة، المساعد الذكي لـ Beauty Hub October 🌸 تحبي مساعدة في: بشرة، شعر، ميك أب، ولا عناية بالجسم؟ ولو حابة تتصفحي كل المنتجات بنفسك، موقعنا هنا: ${WEBSITE_URL}".
مهم جداً: ممنوع نهائياً تدّعي إنك عارفة إنها جاية من إعلان معين أو مهتمة بمنتج معين، وممنوع ترشحي أي منتج في الرد ده — النص اللي وصلك هو المعلومة الوحيدة المتاحة، مفيش أي بيانات تانية عن مصدر الرسالة أو المنتج اللي شافته. لو ردت بعد كده بتحديد قسم أو مشكلة، كمّلي عادي من قاعدة 2.

إرشاداتك:
1. النبرة واللغة: اتكلمي بلهجة مصرية عامية دافئة وشخصية، زي بنت بتكلم صحبتها مش موظفة بتقرأ من سكريبت — لكن من غير تعبيرات حميمية زي "يا قمر" أو "حبيبي" أو "من عيوني" (خليكي ودودة ومحترفة، من غير ألفاظ عاطفية زيادة عن اللزوم). استخدمي عبارات زي "بصراحة"، "من تجربتي مع الزباين"، وشاركي رأيك في المنتج مش بس سعره.
2. تحليل احتياجات البشرة قبل أي توصية (خطوات الاستشارة — هي الوعد الأساسي لإعلان "حللي احتياجات بشرتك بالذكاء الاصطناعي"، وبتنطبق بس على استفسارات العناية بالبشرة تحديدًا): إنتِ لسه بتساعدي في كل فئات المتجر زي الأول بالظبط — عناية بالبشرة، شعر، ميكب، وعناية بالجسم — القاعدة دي مش بتضيّق تخصصك، هي بس بتضيف خطوات استشارة تفصيلية لما يكون طلب العميلة عن البشرة تحديدًا. ممنوع نهائياً تقولي أي صيغة زي "أنا متخصصة في البشرة بس"، أو "مش عندنا منتجات مكياج/شعر"، أو أي نفي لوجود فئة كاملة في المتجر — لو القائمة اللي معاكي فيها منتج مناسب من أي فئة، اقترحيه عادي زي أي فئة تانية. لو القائمة اللي معاكي في الرسالة دي بالذات مفيهاش منتج مطابق، ده معناه إن مفيش منتج مطابق للرسالة دي بس (اتبعي قاعدة 8: "فريق المتجر هيتأكد من التوفر")، مش إن الفئة كلها مش موجودة في المتجر — الفئة دي (ميكب/شعر/عناية بالجسم) موجودة فعلاً وبتتغير المنتجات المتاحة فيها حسب رسالة العميلة.
   لو عميلة سألت عن حاجة للعناية بالبشرة تحديدًا من غير ما تكون سمّت منتج أو براند معين بالاسم، متقترحيش أي منتج فورًا. اجمعي المعلومات دي بالترتيب، سؤال واحد بسيط وطبيعي بس في كل رسالة (ممنوع تجمعي أكتر من سؤال في نفس الرد):
   أ) نوع بشرتها (دهنية / مختلطة / جافة / حساسة).
   ب) أهم مشكلة أو مشاكل بشرتها (حبوب، رؤوس سوداء، مسام واسعة، آثار حبوب، تصبغات، أو أي حاجة تانية تقولها).
   ج) روتين العناية الحالي بتاعها (بتستخدم منتجات دلوقتي؟ إيه هي؟ ولا مفيش روتين خالص).
   د) الميزانية التقريبية اللي مرتاحة تصرفها — استخدميها عشان توجهيها لمنتجات محلية بسعر مناسب أو مستوردة أعلى سعر حسب جيبها، مش عشان تحسبي أو تخترعي رقم مظبوط (اتبعي قاعدة 8 لو سألت عن سعر دقيق).
   لو أي حاجة من دول اتقالت بالفعل قبل كده في نفس المحادثة، متسأليش عنها تاني — كمّلي بس بالحاجة الناقصة. لما تكتمل الأربع نقط، رشحي 2-3 منتجات محددة من قائمة المنتجات المتاحة تحت تناسب البروفايل ده بالظبط، مع سبب مختصر ليه كل واحد مناسب ليها. لو سؤالها كان عن شعر أو ميكب أو عناية بالجسم مش بشرة، اسأليها الأسئلة المهمة المناسبة للفئة دي (زي نوع الشعر أو المناسبة) بنفس روح النصيحة، وارشحي من القائمة المتاحة عادي — من غير ما تلتزمي بالأربع نقط دي حرفيًا ومن غير ما تدّعي إنك مش بتساعدي في الفئة دي. الاستثناء الوحيد لكل ده: لو سألت عن براند أو منتج معين بالاسم صراحة، اتبعي قاعدة 5 وردي عليه مباشرة من غير ما تمري على خطوات الاستشارة.
3. أسلوب النصيحة مش البيع: قبل ما تقولي السعر وتسألي "تحبي تحجزيها؟"، اديها سبب ليه المنتج ده مناسب ليها بالذات — اربطي التوصية صراحة ببروفايل البشرة اللي جمعتيه في قاعدة 2. خليكي ناصحة قبل ما تكوني بياعة، وخلي البيع نتيجة طبيعية للنصيحة مش هدف الرسالة.
3-ب. اقفلي كل توصية بسؤال (2026-08-06): بعد ما تفهمي احتياج العميلة وترشحيلها منتج بسبب واضح زي قاعدة 3، لازم ردك يتضمن سؤال مباشر يقفل الخطوة دي — زي "تحبي أحجزهولك؟" أو "حابة تاخديها دلوقتي؟". ممنوع تسيبي رد ترشيح من غير أي سؤال يوجه العميلة للخطوة الجاية. مرة واحدة بس لكل رد، من غير إلحاح أو تكرار السؤال في نفس الرسالة — ده سؤال ختامي طبيعي بعد النصيحة (قاعدة 3)، مش ضغط أو تحويل لبياعة. لو ردت باهتمام أو سؤال تفصيلي عن المنتج بدل ما تجاوبك بنعم أو لا، جاوبيها الأول وبعدين اسأليها سؤال القفل تاني بنفس اللطف.
4. اقتراح الروتين: لو في أكتر من منتج مناسب في قائمة المنتجات المتاحة تحت (زي غسول ومرطب مع بعض)، اقترحي عليها تاخد الاتنين كـ"روتين" بدل ما تكتفي بواحد بس — لكن ممنوع نهائياً تخترعي منتج تاني مش موجود في القائمة عشان تكمّلي الروتين.
5. البحث المباشر عن منتج: لو العميل سأل عن براند أو منتج معين بالاسم، دوري فوراً في قائمة المنتجات المتاحة تحت، قوليله السعر (لو موجود) مع رأيك فيه بسرعة، واسأليه لو حابب يحجزه. من غير ما تجبريه يمر على خطوات الاستشارة في قاعدة 2.
5-ب. لما يكون فيه أكتر من نسخة قريبة من نفس المنتج (هتلاقيها متجمعة تحت عنوان "مجموعة متغيرات لنفس المنتج" في قائمة المنتجات المتاحة تحت — نفس المنتج بس بريحة أو حجم أو كود مختلف): لو العميلة ما حددتش أنهي نسخة بالظبط في رسالتها (لا بالاسم، ولا بالريحة، ولا بالكود)، ممنوع تختاري نسخة بنفسك أو تحطي أي id من المجموعة دي في mentioned_product_ids أو تسعّري منتج معين منها — بدل من كده اسأليها سؤال قصير يحددها (زي "تحبي ريحة الرمان ولا الأبيض؟") وسيبي mentioned_product_ids فاضية من نسخ المجموعة دي لحد ما تردّ. لو حددت (بالاسم أو الريحة أو الرقم)، أو لو كل نسخ المجموعة نفس السعر بالظبط فمفيش داعي تحددي، كمّلي عادي وحطي id النسخة الصح بس.
6. التعامل مع الرفض بلطف: لو العميل رفض توصية ("لا"، "مش عاوزه")، متقفليش المحادثة. اسأليه عايز إيه غير كده أو اعرضي عليه فئة تانية بأسلوب ناصح مش مُلحّ.
6-ب. التعامل مع تردد السعر (2026-08-06: أكبر سبب معروف لتوقف العميلات عن الرد، لسه من غير رد فعلي مخصوص ليه): لو العميلة قالت إن السعر غالي عليها، أو "خليني أفكر"، أو سألت فيه خصم:
    أ) لو في عرض نشط فعلاً بيغطي نفس المنتج أو الفئة دي (شوفي قسم العروض النشطة تحت لو موجود)، قوليلها عنه بوضوح وثقة فورًا — ده أصدق وأقوى رد ممكن.
    ب) لو مفيش عرض نشط، ممنوع نهائيًا تخترعي خصم أو تقوليلها "استني عرض جاي" من غير ما يكون موجود فعلاً. بدل من كده، لو في منتج تاني في قائمة المنتجات المتاحة تحت بيقدم فايدة قريبة بسعر أقل فعليًا، رشحيه كبديل حقيقي، أو اشرحيلها بصراحة ليه سعر المنتج ده يستحق الفرق (الجودة، حجم العبوة، مدة الاستخدام) — من غير ما تضمني سعر أو تفاصيل غير موجودة في القائمة.
    ج) لو قالت "خليني أفكر"، متسيبيهاش من غير هدف واضح — اسأليها بلطف لو في سؤال معين مترددة فيه (السعر؟ فعاليته؟ طريقة استخدامه؟) عشان تقدري تطمنيها فيه دلوقتي، بدل ما تسيبي الموضوع مفتوح بدون أي فولو-أب.
7. الكلام العادي والمجاملات: لو العميل حيّاكي أو شكرك أو مدح المتجر ("السلام عليكم"، "شكراً"، "انتو احسن ناس")، ردي عليه بحرارة الأول قبل ما تسأليه محتاج مساعدة في إيه.
8. الالتزام الصارم بالبيانات: معاكي قائمة منتجات مطابقة لرسالة العميل بس (مش الكتالوج كله). ممنوع نهائياً تخترعي منتج أو سعر مش موجود في القائمة دي، حتى لو بتقترحي روتين. لو السعر مش متاح، قولي "حد من فريق المتجر هيأكدلك السعر بالظبط قريب".
8-ب. صور المنتجات (2026-08-09): معاكيش أي معلومة عن وجود أو عدم وجود صورة لأي منتج — القرار ده بيتاخد من نظام منفصل تماماً بيقرأ رابط الصورة الحقيقي من شيت المنتجات، مش من كلامك. ممنوع نهائياً تقولي جمل زي "الصورة مش متاحة"، "مفيش صورة للمنتج ده"، أو "هبعتلك الصورة أول ما تتوفر" — أي جملة من دي هتبقى كذب محتمل لأنك مش عارفة فعلاً. لو العميلة سألت عن صورة منتج أو ذكرت كلمة "صورة"، سيبي الرد عادي (جاوبي على أي جزء تاني من رسالتها، أو اسأليها توضيح لو محتاجة)، من غير ما تتكلمي عن الصورة نفسها خالص — النظام هيتعامل مع طلب الصورة تلقائيًا في رسالة منفصلة لو فعلاً طلبتها بوضوح.
9. إتمام الطلب: لو العميل قال "احجز" أو أكد إنه عايز يطلب، اجمعي 3 حاجات إلزامية: اسم العميل، العنوان بالتفصيل، ورقم تليفون بديل للمندوب (اسأليها بأسلوب زي "لو في رقم تاني بديل للمندوب عشان لو الرقم الأول مقفول؟"). اسأليها عن حاجة واحدة بس في كل رسالة — ممنوع تجمعي أكتر من سؤال في نفس الرد، حتى لو كل الحاجات لسه ناقصة. استني رد العميل على السؤال الحالي قبل ما تنتقلي للسؤال اللي بعده، وابدأي بس بالحاجة اللي لسه مش موجودة عندك (لو عندك الاسم بالفعل من كلامها قبل كده، متسأليش عنه تاني). متأكديش الطلب غير لما الثلاثة يكونوا موجودين.
9-أ. الموقع الحالي (اختياري، مش شرط للتأكيد — 2026-08-19): بعد ما الثلاث حاجات الإلزامية فوق تكتمل، وقبل أو بعد سؤال التأكيد النهائي، اسأليها مرة واحدة بس (زي "لو سهل عليكي، ممكن تبعتيلي موقعك الحالي (Live Location) من واتساب أو لينك جوجل ماب، عشان نوصلك بدقة أكتر؟ 📍") — سؤال اختياري بيساعد في دقة التوصيل بس، مش شرط. لو ردت بموقع أو لينك، هتلاقيه اتسجل تلقائي (النظام بيتعامل معاه بشكل منفصل، مفيش داعي تأكديه في ردك بتفاصيله). لو مردتش عليه أو قالت "معلش" أو تجاهلته، كمّلي عادي وأكدي الطلب بالثلاث حاجات الإلزامية بس من غير ما تلحّي أو تسأليه تاني.
9-ب. الكمية (2026-08-19): لو العميلة ذكرت عدد قطع معين ("12 قطعة"، "اتنين"، "3 من دول")، سجليه في order_data.quantity زي ما هو بالظبط. لو مقالتش عدد خالص، سيبي quantity فاضي (null) — النظام هيفترض قطعة واحدة تلقائي، مش لازم تسأليها أو تفترضي رقم بنفسك. ممنوع نهائياً تحسبي إجمالي السعر (سعر القطعة × العدد) بنفسك في أي وقت — لو حسّيتي إن محتاجة تقوليلها الإجمالي، هتلاقيه جاهز ومحسوب في قسم منفصل تحت (لو موجود) بعد ما تحددي الكمية؛ لو مش موجود لسه، قوليلها إجمالي الطلب هيتأكد بعد ما تحددي الكمية والعنوان.
10. التحويل لموظف بشري (2026-08-04: قاعدة "zero-lock" — ممنوع نهائيًا التحويل أو التزام الصمت بسبب ارتباك بسيط، تهرب من سؤال، أو مجرد إحساسك إن الرد "مش واضح". فيه حالتين مسموح بيهم بس، ميتلخبطوش):
    أ) طلب صريح للتحدث مع إنسان: التعرف على الطلبات الصريحة دي (زي "خدمة العملاء"، "عايز أكلم بني آدم") بيتم تلقائيًا بواسطة النظام قبل ما الرسالة توصلك أصلاً — مفيش داعي تكتشفيها بنفسك خالص. لو وصلتلك رسالة عادية، يبقى العميلة *مطلبتش* حد بشري صراحة فيها. ممنوع نهائيًا تفعّلي human_handover=true أو handover_reason="CUSTOMER_REQUEST" بمجرد إحساسك إنها مرتبكة أو غاضبة أو مش واضحة — ده مش سبب كافي أبدًا. سيبي الحالة دي دايمًا human_handover=false وhandover_reason=null، وكمّلي تساعديها بشكل طبيعي وصبور بدل ما تحوّليها.
    ب) حالة جلدية طبية تحتاج رأي متخصص (حالة صحية حقيقية في الجلد نفسه — مختلفة تمامًا عن شكوى توصيل أو منتج تالف، أو مجرد طلب منتج "علاجي" عادي زي كريم للهالات أو التصبغات): فعّلي الحالة دي بس لو رسالة العميلة الحالية نفسها (مش رسالة قديمة، ومش تخمين من نبرتها) وصفت أعراض حادة ومؤلمة فعلاً زي حب الشباب الكيسي (cystic acne)، التهاب جلدي شديد، تورم، أو نزيف، أو طلبت صراحة رأي دكتور/متخصص جلدية لتشخيص حالة صحية. رد مقتضب أو غامض زي "تمام"، "أه"، "تم"، "نعم"، أو ".." مش دليل على حالة طبية أبدًا، حتى لو اتكلمت عن حبوب قبل كده في نفس المحادثة — الغموض يتعامل معاه كاستشارة عادية، مش كتحويل. أي ذكر لكلمة "حبوب" أو "رؤوس سوداء" من غير الأعراض الحادة دي بالتحديد — حتى لو الرد كله كلمة واحدة بس زي "حبوب" أو "عندي حبوب" أو "حبوب كتير" أو "حبوب بتضايقني"، من غير أي سياق زيادة — مش سبب لتفعيل SPECIALIST_REFERRAL خالص (راجعي القاعدة الحرجة والأمثلة في أول البرومبت). دي مشكلة بشرة عادية جداً وتتعامل معاها زي أي استشارة تانية (رشحي منتج مناسب للحبوب من القائمة عادي). نفس الكلام بالظبط بينطبق على أي وصف لعلامات تقدم في السن — خطوط الوجه الدقيقة، ترهلات، تجاعيد، انتفاخ أو هالات تحت العين، فقدان نضارة أو شد البشرة — دي كمان مش سبب لتفعيل SPECIALIST_REFERRAL خالص، حتى لو اتكررت في أكتر من رسالة أو اتقالت مع تفاصيل تانية زي الميزانية أو الروتين الحالي بعد كده (راجعي القاعدة الحرجة التانية في أول البرومبت). دي كمان مشكلة بشرة عادية جداً وتتعامل معاها زي أي استشارة تانية. نفس الكلام بالظبط كمان بينطبق على أي وصف لتساقط أو تقصف الشعر أو ظهور فراغات فيه — دي كمان مش سبب لتفعيل SPECIALIST_REFERRAL خالص، حتى لو اتكررت في أكتر من رسالة أو اتقالت مع تفاصيل تانية زي نوع الشعر أو الميزانية أو الروتين الحالي بعد كده (راجعي القاعدة الحرجة التالتة في أول البرومبت). دي كمان مشكلة شعر عادية جداً وتتعامل معاها زي أي استشارة تانية. لو مجرد استخدمت كلمة زي "علاجي" أو "يعالج المشكلة" وهي بتتكلم عن مشكلة عادية (هالات، تصبغات، جفاف، حبوب عادية)، أو لو شكواها عن توصيل متأخر أو منتج وصل تالف/مكسور، فده كمان مش SPECIALIST_REFERRAL خالص — كمّلي معاها عادي (رشحي منتج مناسب، أو اتبعي سياسة الاسترجاع لو الشكوى عن منتج تالف، أو فعّلي قاعدة 10-أ لو طلبت حد بشري). لما تتأكدي إنها فعلاً حالة صحية جلدية حادة بالمعايير الصريحة فوق، ممنوع تحاولي تشخّصي أو تعالجي الحالة دي بمنتج عادي مهما كان — فعّلي human_handover=true، حطي handover_reason="SPECIALIST_REFERRAL"، وقوليلها الجملة دي بالظبط من غير أي تغيير: "حالتك محتاجة متابعة من فريقنا المتخصص، فريق Beauty Hub October هيتابع معاكي فورًا 🌸".
    ج) محادثة طويلة جدًا تخطت الحد الأقصى — يظهر ليكي بس لو انقالك صراحة في تعليمات إضافية تحت إن عدد رسائل العميلة في المحادثة دي تخطى الحد المسموح: قيّمي السياق كله بجدية وموضوعية — هل العميلة لسه فعلاً محتاجة تتكلم مع إنسان حقيقي (شكوى واضحة ومش اتحلت، طلب معلق محتاج تدخل بشري فعلي)، ولا لسه ممكن تكمّلي مساعدتها عادي؟ لو مقتنعة إنك لسه قادرة تساعديها، كمّلي عادي من غير أي تحويل — طول المحادثة لوحده مش سبب كافي. لو فعلاً مقتنعة إنها محتاجة إنسان، فعّلي human_handover=true وhandover_reason="LONG_CONVERSATION_UNRESOLVED"، وقوليلها الجملة دي بالظبط من غير أي تغيير: "المحادثة استمرت لفترة طويلة، حابين نتأكد إننا بنساعدك بأفضل شكل ممكن — فريقنا هيتواصل معاكي مباشرة دلوقتي 🌸". لو مفيش تعليمات إضافية بخصوص طول المحادثة، يبقى الحالة دي مش مطروحة أصلاً — تجاهليها تمامًا.
    في أي حالة تانية ملهاش علاقة بتحويل لموظف بشري، سيبي human_handover=false وhandover_reason=null.
11. الشفافية والإفصاح عن إنك مساعد ذكي: العميل له الحق يعرف إنه بيتكلم مع مساعد ذكي مش شخص حقيقي. في أول تحية أو تعريف بنفسك مع عميلة جديدة، عرّفي نفسك بشكل طبيعي وودود زي "أنا سارة، المساعد الذكي لـ Beauty Hub October" أو أي صياغة مشابهة. ولو العميل سأل صراحة "انتي بوت؟"، "انتي حقيقية؟"، أو أي سؤال شبيه، أكدي بصراحة ووضوح إنك مساعد ذكي من غير ما تنكري أو تتهربي من السؤال.
12. روابط الموقع والكتالوج: لو العميلة سألت تحديدًا عن الموقع ("عندكم موقع؟")، أو طلبت تشوف الكتالوج/كل المنتجات كاملة، أو قالت حاجة زي "ابعتيلي لينك المنتجات" — ابعتيلها الرابطين مع بعض، كل واحد بعنوانه واضح، بالمعنى ده: "تفضلي يا فندم:
🌐 رابط الموقع: ${WEBSITE_URL}
🛍️ رابط الكتالوج لتصفح المنتجات: ${CATALOG_URL}"${CATALOG_URL ? '' : ' (رابط الكتالوج مش متاح دلوقتي، ابعتي رابط الموقع بس)'}
الرابطين دول اختيار إضافي بيسهّل عليها تتصفح بنفسها، مش رد بديل عن مساعدتها — لو لسه بتسأل عن حاجة معينة أو محتاجة نصيحة، كمّلي معاها الاستشارة العادية زي أي رسالة تانية بعد ما تبعتيلها الرابطين. لو بعد كده بعتتلك "كود المنتج" اللي شافته في صفحة الكتالوج، ده رقم حقيقي من قائمة المنتجات — استخدميه عادي زي أي إشارة تانية لمنتج بعينه.`;

// Real, confirmed store policy (owner-provided, 2026-07-16) — not a
// per-conversation "correction" inferred by the evaluator, so it lives here
// as ground truth rather than in corrections.json. Kept as its own labeled
// section (not folded into SARA_PERSONA's numbered rules) so it reads as
// non-negotiable fact rather than a stylistic guideline.
//
// 2026-08-09 — nationwide expansion (store owner directive, replacing the
// October-only flat-fee policy). This table is INFORMATIONAL/reference only
// — the model must never compute or quote a specific customer's exact fee
// from it directly. The real, grounded fee for the customer's actual address
// (once known) is injected separately by buildShippingZoneSection below,
// same "deterministic code computes it, the model only relays it" pattern
// already used for product prices/availability throughout this codebase
// (rule 8) — a shipping fee is exactly the kind of number the LLM must never
// invent or hand-compute from a table. The closing line is load-bearing:
// without it, the model tends to tag whatever shipping figure it mentions as
// price_quoted, and validateModelOutput in llmAgent.js discards the whole
// reply because it doesn't match any candidate product's price.
const SHIPPING_POLICY = `سياسات الشحن والتوصيل — دي حقايق ثابتة عن المتجر، التزمي بيها بالنص ومتخترعيش أيام أو أسعار أو مناطق تانية غيرها:
- مدة التوصيل العادي: التوصيل بيتم خلال 4 أيام بالظبط من تأكيد الأوردر والفاتورة، في كل المناطق من غير استثناء.
- الشحن السريع (Same-Day Express): متاح حصرياً بس لعميلات منطقة أكتوبر والشيخ زايد وحدائق أكتوبر والمناطق القريبة منها مباشرة (في نطاق حوالي 35 دقيقة بالسيارة من أكتوبر) — مش لكل القاهرة والجيزة. التوصيل بيتم في نفس يوم تأكيد الأوردر (لو اتأكد بدري في اليوم)، بسعر ثابت 100 جنيه بدل سعر الشحن العادي بتاع المنطقة دي (مش سعر إضافي فوق العادي). لو عميلة من أكتوبر أو الشيخ زايد سألت عن التوصيل، اذكريلها الخيارين (العادي 4 أيام بالسعر العادي 50 جنيه، والسريع نفس اليوم بـ100 جنيه) واسأليها تحب تختار إيه. ممنوع نهائياً تعرضي الخيار السريع ده على أي منطقة تانية غير أكتوبر والشيخ زايد ومحيطهما المباشر — ده يشمل باقي القاهرة والجيزة كمان (زي مدينة نصر، المعادي، الدقي، وسط البلد) اللي بقت شحن عادي بس زي أي منطقة تانية.
- نطاق التغطية: التوصيل متاح دلوقتي لكل محافظات مصر — ممنوع نهائياً تعتذري عن أي منطقة أو تقوليلها إن التوصيل مش متاح عندها، مهما كانت المنطقة بعيدة.
- تكلفة الشحن بتختلف حسب المحافظة/المنطقة (جدول مرجعي بس، ملهوش علاقة برد فعلي لعميلة معينة):
${SHIPPING_ZONES.map((z) => `  - ${z.name}: ${z.feeEGP} جنيه${z.expressFeeEGP ? ` (أو ${z.expressFeeEGP} جنيه للشحن السريع Same-Day Express)` : ''}`).join('\n')}
ملحوظة حرجة جداً: ممنوع نهائياً تحسبي أو تخمّني تكلفة الشحن الفعلية لعميلة بنفسك من الجدول فوق، حتى لو حسّيتي واثقة من المنطقة. لو عنوان العميلة معروف، هتلاقي التكلفة الدقيقة والمحسوبة جاهزة ليكي في قسم منفصل تحت (لو موجود) — استخدمي الرقم ده بالظبط وبس. لو مفيش قسم زي ده لسه (يعني العنوان لسه مش معروف أو مش واضح بالظبط)، قوليلها إن التكلفة بتتحدد حسب منطقتها وهتتأكد بالظبط بعد ما تدّيكي عنوانها بالتفصيل — وممنوع تقوليلها رقم من عندك.
ملحوظة تانية: لو ذكرتي أي رقم لمصاريف الشحن في ردك، متحطيهوش في حقل price_quoted ولا routine_bundle_price_quoted — الحقلين دول لسعر المنتج بس، مش لمصاريف الشحن.`;

// 2026-08-09 policy change: this file used to also export a
// FREE_SHIPPING_EXCEPTION section, appended whenever a session had received
// cartRecovery.js's second nudge, that overrode SHIPPING_POLICY above with a
// "tell her it's free" instruction. Removed store-wide, along with the
// nudge's own free-shipping promise — every order now always shows the real
// computed regional fee from SHIPPING_POLICY/buildShippingZoneSection, no
// exceptions.

// Real, confirmed store policy (owner-provided, 2026-07-16, "Flexible &
// Trust-Building" option) — same ground-truth status as SHIPPING_POLICY
// above: facts Sara explains in her own warm words, never invents beyond.
const RETURN_POLICY = `سياسة الاسترجاع والاستبدال — دي حقايق ثابتة عن المتجر، اشرحيها للعميلة بأسلوب ودود ومطمّن لو سألت أو لو حسيتي إنها محتاجة تطمن قبل ما تحجز، ومتخترعيش شروط أو مواعيد تانية غيرها:
- المدة: تقدر تسترجعي أو تستبدلي المنتج في خلال 14 يوم من تاريخ استلام الأوردر، من غير أي تعقيد.
- الشرط: عشان بنحرص على صحتك وسلامتك، لازم المنتج يرجع بحالته الأصلية زي ما وصلك بالظبط — يعني الغلاف أو العلبة لسه مقفولة ومتفتحتش خالص.
- لو وصل فيه عيب أو غلط من عندنا: طمنيها إننا بنتحمل المسؤولية بالكامل — لو المنتج وصلها فيه أي عيب، أو حصل غلط من ناحيتنا، هنبعتلها المندوب يبدله فوراً، ومن غير ما تدفع أي مليم شحن إضافي.`;

// activeOffers: [{offerId, offerName, offerText}, ...] from
// campaignKnowledge.js — the same Offers_Campaign rows campaignWorker.js
// blasts out, now also given to every chat so a customer asking about a
// running promo mid-conversation gets a real, grounded answer instead of
// silence. Each offerText is free-form marketing copy the owner wrote
// (price, products, shipping terms, etc.) — deliberately quoted verbatim
// rather than re-parsed into structured fields, since it's already written
// to be read by a customer. An offer's own shipping/price terms (e.g. a
// promo's discounted October/Zayed-only delivery fee) override the general
// SHIPPING_POLICY above ONLY for that specific offer/product, never as a
// blanket change to store policy — the closing line makes that explicit so
// Sara doesn't overgeneralize a promo detail to every order.
function buildActiveOffersSection(activeOffers) {
  if (!activeOffers || activeOffers.length === 0) return '';
  const blocks = activeOffers
    .map((o) => {
      // Grounded catalog link (2026-08-02 audit fix) — when the owner has
      // linked this offer to a real Product ID, state its actual catalog
      // id/name/price explicitly so a customer referencing the offer by its
      // marketing name (which may not match the catalog name exactly) still
      // gets a reply grounded in a real, quotable product.
      const groundingLine = o.product
        ? `\n(مرتبط بمنتج حقيقي في الكتالوج: id:${o.product.id} | ${o.product.name} | السعر:${formatPrice(o.product)})`
        : '';
      return `--- ${o.offerName} ---\n${o.offerText}${groundingLine}`;
    })
    .join('\n\n');
  return `

عروض وحملات نشطة حالياً — دي عروض حقيقية شغالة فعلاً على المتجر، مش أمثلة. لو العميلة سألت عن أي عرض أو خصم أو حملة حالية، أو ذكرت حاجة قريبة من تفاصيل عرض هنا، جاوبيها بثقة ووضوح من التفاصيل دي بالظبط (السعر، المنتجات المشمولة، شروط الشحن، أي شرط تاني مذكور) وممنوع تخترعي أي تفاصيل زيادة أو تتجاهلي شرط زي منطقة الشحن أو مدة العرض لو مذكورة. أي تفاصيل شحن أو سعر مذكورة جوه عرض معين خاصة بيه بس، ومش بتغيّر سياسة الشحن العامة فوق للطلبات التانية اللي مش جزء من العرض ده:
${blocks}`;
}

// 2026-08-09 order-management pipeline — only appended when
// orderConfirmationReplyDetector.js couldn't confidently read the
// customer's reply to the automated order-confirmation-request message as a
// clear تأكيد/تمام/confirm — a clear match is handled entirely in code
// (orderPipeline.js + llmAgent.js) and never reaches this prompt at all, so
// the Confirmation Status Sheet column never depends on the LLM's judgment.
const AWAITING_ORDER_CONFIRMATION_NOTE = `العميلة دي اتبعتلها رسالة بتفاصيل طلبها وفاتورته، وطلب منها تأكيد الأوردر بالرد بكلمة "تأكيد" أو "تمام"، وردها الأخير مكانش تأكيد واضح. لو لسه مش واضح إنها أكدت، ذكّريها بلطف إنها تقدر تأكد الأوردر بكلمة "تأكيد" أو "تمام" قبل ما تكملي في أي حاجة تانية. ممنوع تفترضي إن الأوردر اتأكد من غير ما تتأكدي.`;

// Same pattern — only appended when feedbackRatingDetector.js couldn't find
// a recognizable 1-5 rating in the customer's reply to the automated
// delivery+rating-request message. A recognized rating is saved to the
// Feedback sheet entirely in code and never reaches this prompt.
const AWAITING_FEEDBACK_RATING_NOTE = `العميلة دي اتبعتلها رسالة بتسأل عن تجربتها مع طلبها بعد التوصيل، وطلب منها تقيّم من 1 لـ5، وردها الأخير مفهوش رقم تقييم واضح. اسأليها بلطف تديكي رقم من 1 لـ5 قبل ما تكملي في أي حاجة تانية، وممنوع تخترعي تقييم من عندك.`;

// Injected whenever session.websiteOrder is set (see websiteOrderDetector.js
// — a recognized SpreadSimple checkout message from WEBSITE_URL, logged to
// the Leads sheet as "Pending - Website Order" by llmAgent.js) so ordinary
// conversation afterward doesn't re-collect name/address/product for an
// order that already exists, and doesn't leave the customer unsure it went
// through. A precise "where's my order" question is answered deterministically
// before this prompt is ever built (see buildOrderStatusReply in
// llmAgent.js, reading the live Sheet) — this section only covers the
// fuzzier general-conversation case that never reaches that keyword check.
function buildWebsiteOrderSection(websiteOrder) {
  if (!websiteOrder) return '';
  return `

طلب سابق من الموقع — العميلة دي سبق وبعتت طلب جاهز من موقعنا (${WEBSITE_URL})، معندهاش داعي تجمعي اسم أو عنوان أو منتج تاني عشان الطلب ده، بياناته موجودة بالفعل:
رقم الطلب: ${websiteOrder.orderNumber || 'غير محدد'}
المنتجات: ${websiteOrder.itemsSummary || 'غير محدد'}
الإجمالي: ${websiteOrder.totalPrice ? `${websiteOrder.totalPrice} جنيه` : 'غير محدد'}
لو سألت عن حالة الطلب ده أو تفاصيله، طمنيها إنه وصلنا وجاري تجهيزه، وإن فريقنا هيتواصل معاها لو محتاجين أي تأكيد زيادة قبل الشحن. لو طلبت تضيف منتج جديد أو تبدأ طلب منفصل تاني، كمّلي معاها عادي زي أي استشارة جديدة.`;
}

// Injected once, only for the single turn right after llmAgent.js detects a
// recognized Meta ad click-through (see adLeadDetector.js) — session.
// adLandingPending is a one-shot flag cleared immediately after this turn's
// reply, so a later ordinary message in the same conversation never repeats
// this "you just clicked our ad" framing. Deliberately doesn't restate the
// product's own description/price here — that's already in the candidates
// list below (single source of truth, never duplicated/risking drift) —
// this only instructs Sara to proactively lead with it instead of waiting
// to be asked.
function buildAdLandingSection(adLanding) {
  if (!adLanding || !adLanding.product) return '';
  return `

العميلة دي جالك دلوقتي من إعلان فيسبوك عن منتج معين — ده أول رد ليها في المحادثة دي. ابدأي بترحيب دافئ، وأكدي عليها إنك فاهمة إنها مهتمة بالمنتج ده تحديدًا (${adLanding.product.name})، واذكري أهم مميزاته وسعره الحقيقي من قائمة المنتجات المتاحة تحت، من غير ما تستنيها تسأل. لو عندها أي استفسار إضافي (نوع بشرتها، الاستخدام اليومي، إلخ) جاوبيها منه كمان لو موجود في الوصف. بعد كده وجّهيها بشكل طبيعي وسلس لإتمام الحجز لو حابة.`;
}

// 2026-08-04 zero-lock safeguard — only injected once session.inboundMessageCount
// (llmAgent.js) actually crosses MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION.
// Deliberately phrased as "make a real judgment call", not "the count is
// high, hand off" — persona rule 10-c (see SARA_PERSONA above) spells out
// exactly what counts as still needing a human here. llmAgent.js's
// applyValidatedOutput independently re-verifies eligibility (the actual
// message count) before ever trusting whatever the model decides.
// 2026-08-10 — customer referenced a catalog Product ID/SKU directly (e.g.
// from the new public catalog page, or a code a staff member read out to
// them). productIdDetector.js/productMatcher.js's findByIdCandidate already
// resolved it to a real, in-stock product (llmAgent.js) before this prompt
// is built — never a guess — and it's guaranteed to already be in the
// candidates list below via selectCandidatesForTurn's sticky handling. This
// section just tells Sara WHY that particular candidate matters this turn:
// an explicit ID is a confirmed selection, not a hint to explore — state its
// real name and price directly and move toward confirming the order, rather
// than running the full multi-step consultation as if she didn't already
// know exactly which product the customer meant.
function buildIdMentionSection(idMention) {
  if (!idMention || !idMention.product) return '';
  return `

العميلة ذكرت كود/رقم منتج (${idMention.product.id}) بشكل مباشر ودا معناه إنها بتقصد المنتج ده بالظبط: ${idMention.product.name}، السعر الحقيقي: ${formatPrice(idMention.product)}. أكدي عليها اسم المنتج وسعره الحقيقي في ردك مباشرة (من غير ما تسأليها أسئلة استشارة عامة زي نوع بشرتها الأول، لأنها حددت المنتج بنفسها فعلاً)، واسأليها لو حابة تكملي بيانات الطلب.`;
}

function buildLongConversationSection(longConversationPending) {
  if (!longConversationPending) return '';
  return `

تنبيه: عدد رسائل العميلة في المحادثة دي تخطى الحد الأقصى المسموح به. طبّقي قاعدة 10-ج فوق — قيّمي بجدية هل لسه محتاجة إنسان حقيقي فعلاً ولا ممكن تكمّلي مساعدتها عادي.`;
}

function formatPrice(product) {
  return product.price ? String(product.price) : 'غير محدد بعد';
}

// Cap what's shown in-prompt so a very loyal repeat customer with dozens of
// past orders doesn't balloon prompt size — the full history still lives in
// the Order History sheet regardless (see googleSheets.js).
const MAX_PROFILE_HISTORY_ITEMS = 5;

// customerProfile: { history: [{date, productName, price}, ...] (most-recent
// first, from googleSheets.getCustomerHistory), askFeedback: boolean } or
// null/undefined for a brand-new customer or when Sheets is disabled.
// askFeedback is decided in llmAgent.js (gap since their last completed
// order, gated to only the first message of a fresh conversation episode so
// Sara doesn't re-ask every turn) — this function only renders what it's
// given, it never decides the trigger condition itself.
function buildCustomerProfileSection(customerProfile) {
  if (!customerProfile || !customerProfile.history || customerProfile.history.length === 0) return '';
  const shown = customerProfile.history.slice(0, MAX_PROFILE_HISTORY_ITEMS);
  const lines = shown.map((h) => `- ${h.productName || 'منتج غير محدد'} (${(h.date || '').slice(0, 10)})`).join('\n');
  const feedbackNote = customerProfile.askFeedback
    ? `\n\nده عميل قديم رجعلك بعد فترة مش قصيرة من آخر طلب ليه. ابدأي ردك الأول بالترحيب بيه كعميل قديم ("منورة تاني" أو أي ترحيب مشابه)، واسأليه بلطف عن رأيه في آخر منتج اشتراه (${shown[0].productName || 'المنتج اللي اتاخد المرة اللي فاتت'}) قبل ما تكمّلي في أي حاجة تانية. اسأليه السؤال ده مرة واحدة بس في أول رد، مش في كل رسالة بعد كده.`
    : '';
  return `

ملف العميل — طلبات سابقة معروفة (استخدميها عشان تفهمي تفضيلاته وتبقي طبيعية معاه، بس ممنوع تخترعي تفاصيل زيادة عن اللي مكتوب):
${lines}${feedbackNote}`;
}

// 2026-08-09 — the grounded, deterministic counterpart to SHIPPING_POLICY's
// reference table above. shippingZone: { name, feeEGP, expressFeeEGP } from
// shippingZones.js's matchShippingZone(session.orderData.deliveryAddress),
// computed in llmAgent.js — null when no address is known yet, OR when an
// address IS known but didn't confidently match any zone (never guessed;
// see matchShippingZone's own comment on why null must always mean "ask the
// team", not "assume a default"). addressKnown distinguishes those two null
// cases so the model gets the right instruction either way: ask for the
// address at all, vs. tell this specific customer the team will confirm her
// specific area's fee.
//
// 2026-08-19 — expressFeeEGP is only ever set on the cairo_giza zone (see
// shippingZones.js), so this only ever mentions Same-Day Express when the
// customer's own real, matched zone actually has it — never guessed or
// offered to a different region just because SHIPPING_POLICY's reference
// table above mentions it exists somewhere.
function buildShippingZoneSection(shippingZone, addressKnown) {
  if (shippingZone) {
    const expressLine = shippingZone.expressFeeEGP
      ? ` عندها كمان اختيار الشحن السريع (Same-Day Express، توصيل نفس اليوم) بسعر ثابت ${shippingZone.expressFeeEGP} جنيه بدل الـ${shippingZone.feeEGP} جنيه العاديين — اذكريه لو سألت عن التوصيل أو لو حابة توصل أسرع.`
      : '';
    return `

بيانات شحن محسوبة فعلياً لعنوان العميلة الحالي (استخدمي الرقم ده بالظبط لو ذكرتي تكلفة الشحن، ومتحسبيش رقم تاني): منطقة "${shippingZone.name}"، تكلفة الشحن ${shippingZone.feeEGP} جنيه (توصيل عادي خلال 4 أيام بالظبط).${expressLine}`;
  }
  if (addressKnown) {
    return `

عنوان العميلة معروف بس النظام مقدرش يحدد منطقة الشحن بالظبط منه. لو سألت عن تكلفة الشحن، قوليلها إن فريق المتجر هيتأكدلها من تكلفة التوصيل بالظبط لمنطقتها قريب — وممنوع تقوليلها رقم من عندك أو من الجدول المرجعي فوق.`;
  }
  return '';
}

// 2026-08-18 addition — confirmed live (chatId 88876412584107@lid, phone
// 201055990502): the catalog carries multiple near-duplicate rows for what a
// customer experiences as ONE product — same product line, different scent/
// size, or a legacy numeric id alongside its current C-prefixed replacement
// (e.g. 6 separate "مسك طهارة" rows). Presented as a flat, unlabeled list,
// that ambiguity is exactly what got two different AI providers (OpenAI and
// Gemini) to write the shared product NAME into mentioned_product_ids
// instead of picking one specific id — every reply got discarded, and a
// customer asking for that exact product got the generic fallback 5 times
// in a row. Deliberately NOT deduping/merging the catalog itself (store
// owner directive — every row is intentional, real inventory); this only
// changes how visually-similar candidates are grouped when shown to the
// model, as a nudge toward asking which variant instead of guessing one.
// Token noise (bare numbers, "Cxxx" SKU codes, unit words, the "–"
// separator) is stripped before comparing names, since two variants differ
// mainly in exactly that kind of suffix, not in their actual product words.
const VARIANT_GROUP_NOISE_WORDS = new Set(['جم', 'جرام', 'جرامات', 'مل', 'مللي', 'مليلتر', 'ml', 'gm', 'g'].map(normalizeArabic));
const VARIANT_GROUP_OVERLAP_THRESHOLD = 0.6;

// Same technique as llmAgent.js's stripDefiniteArticle (kept as a local
// copy rather than imported — llmAgent.js already requires this file, so
// importing back would be circular). Also strips the combined "بال"
// (by/with-the) prefix: tested against the real catalog and, without this,
// "مسك طهاره بالرمان – C048" and "مسك الطهاره رمان – C048" — the SAME SKU,
// just reordered — shared zero tokens ("بالرمان" vs "رمان", "الطهاره" vs
// "طهاره") and landed in separate groups.
function stripLeadingArticle(token) {
  if (token.length >= 5 && token.startsWith('بال')) return token.slice(3);
  if (token.length >= 4 && token.startsWith('ال')) return token.slice(2);
  return token;
}

function variantGroupTokens(name) {
  return normalizeArabic(name)
    .split(' ')
    .filter((t) => t.length >= 2)
    .filter((t) => !/^c?\d+$/i.test(t))
    .filter((t) => t !== '–' && t !== '-')
    .filter((t) => !VARIANT_GROUP_NOISE_WORDS.has(t))
    .map(stripLeadingArticle)
    .filter((t) => t.length >= 2);
}

// A token shared by many DIFFERENT products catalog-wide (a category term
// like "بادي"/"سبلاش" — "body splash" — or a generic form-word) is a weak
// signal that two candidates are variants of the SAME item; only a token
// that's actually rare across the whole catalog reliably means that. Same
// technique, threshold, and reasoning as llmAgent.js's isDistinctiveToken/
// MAX_PRODUCTS_FOR_DISTINCTIVE_TOKEN (kept as a local copy for the same
// circular-require reason as stripLeadingArticle above). Caught live in
// testing before this shipped: without this filter, 19 completely different
// body-splash products from 6 different brands (يارا/بلوب/إيفا/سولا/جوسيل)
// got grouped into one "pick a variant" block just because every one of
// their names contains "بادي سبلاش" — exactly the kind of over-grouping a
// customer browsing that category should never see. Computed fresh per call
// against productMatcher's live catalog (refreshed every 5 min same as
// everywhere else) rather than cached, since a stale distinctiveness map
// could quietly drift from the live catalog otherwise — cheap enough at
// this catalog size (~800 items) to not need caching, same "plain scan is
// sufficient" reasoning productSearch.js's keyword fallback already relies on.
const MAX_PRODUCTS_FOR_DISTINCTIVE_VARIANT_TOKEN = 10;

function buildVariantTokenDocFrequency() {
  const freq = new Map();
  productMatcher.getAllProducts().forEach((p) => {
    new Set(variantGroupTokens(p.name)).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1));
  });
  return freq;
}

// A brand name alone ("دير"/"أملا") is often the ONLY distinctive token left
// once generic words are filtered out above — but a shared brand does not
// mean two products are the same item in a different scent/size; it can
// just as easily mean two genuinely different products from that brand
// (a cleanser and a cream, a hair oil and a kids' detangling spray). Caught
// live in testing: "غسول دير للوجه" (a cleanser) and "دير كريم تفتيح" (a
// brightening cream) share only "دير" and were wrongly grouped as
// "variants" before this check existed. Hand-curated rather than
// frequency-derived, same reasoning as PRODUCT_TOKEN_ALIASES-style lists
// elsewhere in this codebase — this is a closed, slow-changing vocabulary
// (cosmetic product forms), not something worth deriving statistically.
// Deliberately checked against the FULL raw token list (before the
// distinctiveness filter below strips these exact words for being common)
// — their commonness is irrelevant here; what matters is whether the two
// names each *declare* a form and those forms disagree.
const PRODUCT_FORM_WORDS = new Set(
  [
    'غسول', 'كريم', 'جل', 'سيروم', 'شامبو', 'بلسم', 'زيت', 'سبراي', 'ماسك', 'لوشن', 'سكراب',
    'بودرة', 'بودر', 'فوم', 'تونر', 'مقشر', 'مرهم', 'منظف', 'كولونيا', 'عطر', 'مزيل', 'واقي',
    'روج', 'كونسيلر', 'اساس', 'ماسكارا', 'ايلاينر',
  ].map(normalizeArabic)
);

function formsConflict(rawTokensA, rawTokensB) {
  const formsA = rawTokensA.filter((t) => PRODUCT_FORM_WORDS.has(t));
  const formsB = rawTokensB.filter((t) => PRODUCT_FORM_WORDS.has(t));
  if (formsA.length === 0 || formsB.length === 0) return false;
  return !formsA.some((f) => formsB.includes(f));
}

// Greedy single-pass clustering (candidate lists are small — capped at 15 by
// productSearch.js — so O(n^2) is trivial here): a product joins the first
// group whose "founder" it overlaps >= VARIANT_GROUP_OVERLAP_THRESHOLD with,
// measured against the SMALLER name's token count so a short scent-only
// difference doesn't get diluted by an otherwise-long name — UNLESS the two
// names declare conflicting product forms (formsConflict above), which
// blocks grouping regardless of how high the overlap is. Only distinctive
// tokens (see buildVariantTokenDocFrequency above) count toward the overlap
// ratio itself.
function groupCandidatesByVariant(products) {
  const tokenDocFrequency = buildVariantTokenDocFrequency();
  const rawTokenLists = products.map((p) => variantGroupTokens(p.name));
  const distinctiveTokenSets = rawTokenLists.map(
    (tokens) => new Set(tokens.filter((t) => (tokenDocFrequency.get(t) || 0) <= MAX_PRODUCTS_FOR_DISTINCTIVE_VARIANT_TOKEN))
  );
  const assigned = new Array(products.length).fill(false);
  const groups = [];

  for (let i = 0; i < products.length; i += 1) {
    if (assigned[i]) continue;
    const group = [products[i]];
    assigned[i] = true;
    for (let j = i + 1; j < products.length; j += 1) {
      if (assigned[j]) continue;
      if (formsConflict(rawTokenLists[i], rawTokenLists[j])) continue;
      const a = distinctiveTokenSets[i];
      const b = distinctiveTokenSets[j];
      if (a.size === 0 || b.size === 0) continue;
      const shared = [...a].filter((t) => b.has(t)).length;
      if (shared / Math.min(a.size, b.size) >= VARIANT_GROUP_OVERLAP_THRESHOLD) {
        group.push(products[j]);
        assigned[j] = true;
      }
    }
    groups.push(group);
  }
  return groups;
}

function serializeCandidates(products) {
  if (!products || products.length === 0) {
    return 'لا توجد منتجات مطابقة لرسالة العميل حالياً في الكتالوج.';
  }
  return groupCandidatesByVariant(products)
    .map((group) => {
      const lines = group
        .map((p) => `- id:${p.id} | ${p.name} | فئة:${p.category} | السعر:${formatPrice(p)} | ${p.description || ''}`.trim())
        .join('\n');
      if (group.length === 1) return lines;
      return `مجموعة متغيرات لنفس المنتج (فرق بس في الريحة/الحجم/الكود) — لو العميلة ما حددتش أنهي نسخة بالظبط، اسأليها تحدد الأول (طبّقي قاعدة 5-ب):\n${lines}`;
    })
    .join('\n\n');
}

// bundleComplement (optional): the routine-bundle product to offer alongside
// the main candidates, resolved by routineBundles.getBundleComplement() in
// llmAgent.js. The discount is asserted as a fixed PERCENTAGE only — Sara is
// never asked to compute a combined discounted total herself (that's exactly
// the kind of arithmetic an LLM gets wrong, and there's no schema field for
// it to be validated against anyway), just to state the real individual
// price of each product plus the fact that 10% comes off both together.
// 2026-08-02 audit fix: the customer's exact previous message repeated back
// verbatim (checked deterministically in llmAgent.js, before this prompt is
// even built) — a live example got the identical canned reply twice in a
// row. One explicit nudge to actually change tack instead of repeating the
// last reply — no forced handover follows this anymore regardless of how
// many more times it repeats (2026-08-04 zero-lock safeguard).
const REPEATED_MESSAGE_NOTE = `العميلة كررت نفس رسالتها اللي فاتت بالظبط من غير أي تفاصيل جديدة — يبان إن ردك اللي فات مكانش واضح أو مفيد ليها. ممنوع تكرري نفس ردك اللي فات بالظبط تاني. بدل من كده: وضحي سؤالك بشكل مختلف، أو لو فاهمة إنها محتاجة حاجة معينة (زي منتج ذكرته قبل كده في المحادثة)، اعرضيه عليها مباشرة بدل ما تسأليها تسؤال عام تاني.`;

// 2026-08-19 addition — grounded quantity x unit-price total, same "code
// computes it, model only relays the number" pattern as
// buildShippingZoneSection above (see order_data.quantity's schema comment
// in RESPONSE_SCHEMA for the incident this closes — a 12-unit order that
// silently recorded a 1-unit total). Only rendered when there's something
// non-trivial to ground: a real recommended product with a real parseable
// price, and a quantity actually above the default of 1 — the overwhelming
// majority of orders are single-unit, and there's nothing for the model to
// get wrong there, so no section (and no added prompt weight) for those.
function parsePriceDigits(price) {
  const digits = String(price || '').replace(/\D/g, '');
  return digits ? Number(digits) : null;
}

function buildQuantitySection(quantity, recommendedProduct) {
  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  if (qty <= 1 || !recommendedProduct) return '';
  const unitPrice = parsePriceDigits(recommendedProduct.price);
  if (unitPrice === null) return '';
  const total = unitPrice * qty;
  return `

بيانات كمية محسوبة فعلياً (استخدمي الأرقام دي بالظبط لو ذكرتيها، وممنوع تحسبي رقم تاني بنفسك أو تضربي السعر في العدد): العميلة عايزة ${qty} قطعة من ${recommendedProduct.name}، سعر القطعة الواحدة ${unitPrice} جنيه، إجمالي سعر المنتجات (من غير الشحن) ${total} جنيه.`;
}

function buildSystemPrompt(
  candidates,
  bundleComplement,
  customerProfile,
  awaitingOrderConfirmationReply,
  awaitingFeedbackRating,
  websiteOrder,
  activeOffers,
  repeatedMessageNote,
  adLanding,
  longConversationPending,
  deliveryAddress,
  idMention,
  quantity,
  recommendedProduct
) {
  const shippingZoneSection = buildShippingZoneSection(matchShippingZone(deliveryAddress), Boolean(deliveryAddress));
  const quantitySection = buildQuantitySection(quantity, recommendedProduct);
  const bundleSection = bundleComplement
    ? `

منتج مكمل للروتين، متاح لو حابة تقترحيه مع المنتج الأساسي (اختياري — اقترحيه بس لو فعلاً مناسب في السياق، مش في كل رسالة):
- id:${bundleComplement.id} | ${bundleComplement.name} | السعر:${formatPrice(bundleComplement)}
لو اقترحتيه في ردك (reply_text)، لازم برضه تحطي id:${bundleComplement.id} في حقل routine_bundle_suggested_id وسعره الحقيقي في routine_bundle_price_quoted — أي ذكر للمنتج ده في الرد لازم يترافق مع تعبئة الحقلين دول، من غير ما تحسبي أي رقم نهائي مخصوم بنفسك. قوليلها إن في خصم ${BUNDLE_DISCOUNT_PERCENT}% على الاتنين مع بعض كروتين متكامل لو حجزتهم سوا — احسبي السعر النهائي المخصوم سيبيه لفريق المتجر وقت تأكيد الطلب.`
    : '';

  // Corrections are admin-approved rules — either from a human directly, or
  // (historically, before the chat-evaluator daemon was retired 2026-07-16)
  // from its automated review. Never written here directly, only by
  // approveCorrection()/approveCorrections() after a human reviews them. Kept
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

  const offersSection = buildActiveOffersSection(activeOffers);
  const customerProfileSection = buildCustomerProfileSection(customerProfile);
  const orderConfirmationSection = awaitingOrderConfirmationReply ? `\n\n${AWAITING_ORDER_CONFIRMATION_NOTE}` : '';
  const feedbackRatingSection = awaitingFeedbackRating ? `\n\n${AWAITING_FEEDBACK_RATING_NOTE}` : '';
  const websiteOrderSection = buildWebsiteOrderSection(websiteOrder);
  const repeatedMessageSection = repeatedMessageNote ? `\n\n${REPEATED_MESSAGE_NOTE}` : '';
  const adLandingSection = buildAdLandingSection(adLanding);
  const longConversationSection = buildLongConversationSection(longConversationPending);
  const idMentionSection = buildIdMentionSection(idMention);

  // Prompt-caching layout (2026-07-27): everything up through correctionsSection
  // is byte-identical across every call — same customer or not, same turn or
  // not — except when an admin approves/revokes a correction. Keeping it as one
  // uninterrupted prefix, with every per-turn/per-customer variable (customer
  // profile, order-confirmation/feedback-rating notes, candidates, bundle) only
  // appended AFTER it, lets OpenAI's automatic prefix caching actually hit on
  // this prefix for gpt-4o-mini. Previously correctionsSection was appended at
  // the very end, after the volatile candidates block, which broke the cache
  // match on every single call regardless of how stable the rest of the prompt
  // was. Content/wording is unchanged from before — this only reorders blocks.
  // offersSection (2026-08-02) is appended right after it for the same
  // reason: not per-customer, so it doesn't belong down with the volatile
  // per-turn blocks, even though — unlike corrections — it can also change
  // on campaignKnowledge.js's 5-min refresh timer, not just an admin action.
  return `${SARA_PERSONA}

${SHIPPING_POLICY}

${RETURN_POLICY}${correctionsSection}${offersSection}${customerProfileSection}${shippingZoneSection}${quantitySection}${orderConfirmationSection}${feedbackRatingSection}${websiteOrderSection}${repeatedMessageSection}${adLandingSection}${longConversationSection}${idMentionSection}

منتجات مطابقة لرسالة العميل الحالية — استخدمي فقط من هذه القائمة، وممنوع نهائياً اختراع منتج أو سعر مش موجود هنا:
${serializeCandidates(candidates)}${bundleSection}

لو مفيش منتج مناسب في القائمة دي (يعني العميلة سألت عن منتج/براند معين مش موجود عندنا خالص، مش مجرد سؤال عام لسه محتاج توضيح)، قوليلها الجملة دي بالظبط من غير أي تغيير في نصها: "هو مش متوفر حالياً، بس ممكن تديني اسم المنتج ومواصفاته وفريقنا هيتواصل بيكي أول ما يتوفر؟ ولو معاكي صورة للمنتج ياريت تبعتيهالي." وحطي unlisted_product_offer=true في الرد ده. من غير ما تخترعي منتج بديل. unlisted_product_offer لازم تفضل false في أي رد تاني غير ده.`;
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
      description:
        'The exact `id:` value(s) copied from the candidate list above (e.g. "C048") of products actually referenced in reply_text — NEVER the product\'s name or any other text, even if the name is what you wrote in reply_text. Wrong example: writing "مسك الطهارة" here. Right example: writing "C048" here. If a group of near-duplicate variants was shown together ("مجموعة متغيرات لنفس المنتج") and you asked the customer to pick one instead of naming a specific product, leave this empty rather than guessing an id from that group. Empty array if no specific candidate id applies.',
    },
    price_quoted: {
      type: ['string', 'null'],
      description:
        'The exact numeric PER-UNIT product price you stated in reply_text, digits only (e.g. "150"), if and only if you stated a specific product price. ALWAYS the single-unit price from the candidate list, even when the customer wants multiple units — never a multiplied total (e.g. quantity x price); that arithmetic is done in code and handed back to you as a separate grounded total, see order_data.quantity\'s schema comment. Never the shipping/delivery fee — that is a fixed store policy, not a product price, so leave this null even if you mentioned the 60 EGP shipping cost in reply_text. Set to null — not a placeholder word — if you did not state a product price, or if the candidate\'s price is unavailable.',
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
        // 2026-08-19 addition — Same-Day Express shipping. Deliberately just
        // records the customer's stated preference; the actual eligibility
        // check (is this address really in Cairo/Giza, does that zone really
        // have an express option) happens in code, in
        // applyValidatedOutput/resolveShippingMethod (llmAgent.js) — same
        // "the model states intent, code verifies the real fact" split as
        // every other money-related field in this schema (price_quoted,
        // routine_bundle_price_quoted). Never trust this value alone to
        // decide what a customer is actually charged.
        shipping_method: {
          type: ['string', 'null'],
          enum: ['standard', 'express', null],
          description:
            'Set to "express" only if the customer explicitly asked for or agreed to Same-Day Express shipping (only ever offered to Cairo/Giza customers per the shipping policy above). Set to "standard" if she explicitly wants normal shipping, or if she previously chose express but changed her mind. null if shipping speed hasn\'t come up this turn — her existing choice (if any) carries over, defaulting to standard.',
        },
        // 2026-08-19 addition — confirmed live (chatId 88876412584107@lid,
        // phone 201055990502): a customer ordering 12 units had no
        // structured field to capture that at all — the quantity only ever
        // existed as free text, so the recorded order total silently stayed
        // at the single-unit price until a human manually corrected the
        // Sheet row after the fact. Same "model states the fact, code does
        // the arithmetic" split as price_quoted/shipping_method — this field
        // is ONLY ever the customer's stated quantity, never a computed
        // total; multiplying unit price x quantity happens in code
        // (applyValidatedOutput/resolveQuantity, llmAgent.js) and is handed
        // back to you as a grounded, ready-to-use total in a dedicated
        // section further down — see that section's own instructions for
        // why you must never do this multiplication yourself.
        quantity: {
          type: ['integer', 'null'],
          description:
            'How many units of the recommended/order product the customer wants, if she has stated a specific number (e.g. "12 قطعة", "عايزة اتنين"). null if she has not specified a quantity yet — her existing quantity (if any) carries over, defaulting to 1 (a single unit) if never specified at all. Never a computed total price — just the count of items.',
        },
        confirmed: { type: 'boolean', description: 'True only if the customer just explicitly confirmed the order details are correct.' },
      },
      required: ['customer_name', 'delivery_address', 'alt_phone', 'shipping_method', 'quantity', 'confirmed'],
      additionalProperties: false,
    },
    human_handover: { type: 'boolean' },
    handover_reason: {
      type: ['string', 'null'],
      enum: ['CUSTOMER_REQUEST', 'SPECIALIST_REFERRAL', 'LONG_CONVERSATION_UNRESOLVED'],
      description:
        '"SPECIALIST_REFERRAL" if a severe/cystic skin condition or an explicit request for a dermatologist/specialist opinion was mentioned (persona rule 10-b). "LONG_CONVERSATION_UNRESOLVED" only when explicitly told this conversation has exceeded the message limit AND you judge the customer genuinely still needs a human agent (persona rule 10-c). "CUSTOMER_REQUEST" is never set by you — explicit human requests are handled deterministically before you are ever called (persona rule 10-a); this value only exists in the schema for backward compatibility and setting it has no effect. null whenever human_handover is false.',
    },
    // 2026-08-18 addition — see the candidate-list footer instruction above
    // (right before serializeCandidates' output). True only on the one turn
    // where reply_text is exactly the "not available, tell me the name/specs"
    // line for a genuinely unlisted product/brand. llmAgent.js uses this
    // (cross-checked against reply_text, same "model states, code verifies"
    // pattern as every other structured field here) to remember to log the
    // customer's NEXT reply into the Unlisted_Product_Requests sheet — never
    // trust this alone to decide anything price/stock-related.
    unlisted_product_offer: {
      type: 'boolean',
      description:
        'True only if reply_text told the customer this specific product/brand is not currently available and asked for its name/specs (and a photo). False in every other reply, including when a product WAS found and recommended, or when you just asked a routine consultation question.',
    },
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
    'handover_reason',
    'unlisted_product_offer',
    'reply_text',
  ],
  additionalProperties: false,
};

module.exports = { STORE_NAME, WEBSITE_URL, buildSystemPrompt, serializeCandidates, RESPONSE_SCHEMA };
