const {
  getSession,
  updateSession,
  STAGES,
  isOrderConfirmationReplyExpired,
  isFeedbackRatingExpired,
} = require('./conversationMemory');
const escalationDetector = require('./escalationDetector');
const { containsAny, containsWord, normalizeArabic, truncate } = require('../utils/helpers');
const { buildEscalationResponse, baseLogFields, resolveEarlyStageOrderStatus } = require('./sessionLogHelpers');
const orderConfirmationReplyDetector = require('./orderConfirmationReplyDetector');
const feedbackRatingDetector = require('./feedbackRatingDetector');
const orderStatusDetector = require('./orderStatusDetector');
const websiteOrderDetector = require('./websiteOrderDetector');
const adLeadDetector = require('./adLeadDetector');
const productImageRequestDetector = require('./productImageRequestDetector');
const productIdDetector = require('./productIdDetector');
const { matchShippingZone } = require('./shippingZones');
const productSearch = require('./productSearch');
const productMatcher = require('./productMatcher');
const localService = require('../services/localService');
const geminiService = require('../services/geminiService');
const openaiService = require('../services/openaiService');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('./llmSystemPrompt');
const {
  MESSAGES,
  ORDER_CANCELLATION_REQUEST_KEYWORDS,
  productImageNotAvailable,
  productImageReply,
  orderConfirmationSummary,
} = require('./prompts');
const config = require('../config');
const logger = require('../utils/logger');
const trainingDataLogger = require('../utils/trainingDataLogger');
const agentStats = require('./agentStats');
const routineBundles = require('./routineBundles');
const campaignKnowledge = require('./campaignKnowledge');
const googleSheets = require('../services/googleSheets');

// Rolling window, not the full conversation — bounds prompt size/cost/latency
// so a long-running customer's per-message cost doesn't keep growing forever
// and can never exceed the model's context window. 40 entries (~20 user/model
// turn pairs) was chosen from real production data (training-data/conversations.jsonl,
// 2026-07-27 audit), not a round number: 60 covered every real conversation
// seen so far (max 63 entries) but so does 40 — it lands at roughly the p95 of
// real history lengths, trading a small tail of very long conversations for
// meaningfully smaller prompts on the common case. Going lower (e.g. 20) was
// evaluated and rejected: 16% of real logged conversations already exceed 20
// entries, so that cap would make Sara visibly forget facts (skin type,
// budget, name) a customer already gave earlier in the same conversation. The
// full, untruncated history is still captured separately in Google Sheets'
// Conversation History note and in training-data/conversations.jsonl (see
// trainingDataLogger.js) for the 2-month data-gathering goal, regardless of
// what's replayed into the live prompt.
const MAX_HISTORY_TURNS = 40;

// A conversation counts as a fresh "episode" once the session has sat idle
// this long — used to gate the returning-customer feedback ask so it can
// only fire on the first message of a new episode, not every turn of an
// hours-long live conversation (session.updatedAt refreshes every message,
// so this naturally stops re-triggering after the first hit).
const NEW_EPISODE_GAP_MS = 6 * 60 * 60 * 1000; // 6 hours
// Only ask for feedback on a past order once it's had a few days to actually
// be used — asking the day after purchase reads as impatient, not caring.
const RETURNING_CUSTOMER_FEEDBACK_GAP_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// customerProfile passed into buildSystemPrompt(): { history, askFeedback }
// from googleSheets.getCustomerHistory(phone) (a pure in-memory Map lookup,
// safe to call every message — see googleSheets.js), or null for a brand-new
// customer. askFeedback only true on the first message of a fresh episode
// (previousUpdatedAt, captured BEFORE this turn touches the session) whose
// most recent completed order is old enough to plausibly have an opinion on.
function buildCustomerProfile(phone, previousUpdatedAt) {
  const history = googleSheets.getCustomerHistory(phone);
  if (history.length === 0) return null;

  const isNewEpisode = !previousUpdatedAt || Date.now() - previousUpdatedAt > NEW_EPISODE_GAP_MS;
  const lastOrder = history[0];
  const askFeedback = isNewEpisode && Date.now() - lastOrder.timestamp > RETURNING_CUSTOMER_FEEDBACK_GAP_MS;

  return { history, askFeedback };
}

// 2026-08-04 zero-lock safeguard (store owner directive): neither
// session.noProgressTurns (order-collection stalling) nor
// session.consecutiveRepeats (the customer repeating their exact previous
// message) force a handover anymore — see where each is computed below for
// what they still drive (a log note, and a one-time soft prompt nudge,
// respectively). Vague stalling/repetition is not hard evidence a customer
// needs a human; the only remaining message-volume-based escalation path is
// MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION further down.

// 2026-08-04 zero-lock/zero-handover safeguard (store owner directive): the
// bot must never auto-silence itself or hand off on minor confusion,
// deflections, or the backstops above — the ONLY auto-handover path left is
// a single session exceeding this many real inbound customer messages, and
// even then only after the LLM itself confirms (via the long-conversation
// prompt section below) the customer genuinely still needs a human agent
// right now, not just that the count crossed the line. Explicit human
// requests and genuine clinical-severity referrals are unaffected by any of
// this — those are handled by escalationDetector.js (deterministic, before
// the LLM is ever called) and the independently-verified SPECIALIST_REFERRAL
// path in applyValidatedOutput respectively, neither of which this constant
// touches.
const MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION = 60;

// 2026-07-18: deterministic ground-truth guard on SPECIALIST_REFERRAL — the
// same "trust but verify" principle validateModelOutput already applies to
// prices and product ids (never trust the model's own claim, check it
// against real data), extended to the human-handover decision. sim_run3/
// sim_run4, and a live harness re-test of the llmSystemPrompt.js prompt-only
// fix (explicit top-of-prompt rule + few-shot examples), both showed
// gpt-4o-mini still escalating a bare "حبوب" or "عندي حبوب بتضايقني" reply to
// SPECIALIST_REFERRAL and skipping any product recommendation — prompt
// wording alone doesn't reliably override this model's caution bias on skin/
// health topics for a single, context-free word. This backstop never trusts
// handover_reason==="SPECIALIST_REFERRAL" at face value; see
// applyValidatedOutput below.
//
// 'دم' (blood) and 'ألم' (pain) are checked as whole words (containsWord),
// not substring — unlike the rest of this list they're short roots that
// collide with extremely common, unrelated words once normalizeArabic
// (helpers.js) folds أ/إ/آ all down to plain ا: 'ألم' normalizes to 'الم',
// which is a literal substring of 'المتاح' ("available") — confirmed live
// when a persona's "ايه المتاح؟" false-matched this keyword, suppressed the
// guard, and let a bare escalation slip through uncaught. 'دم' has the same
// problem with 'خدمة' ("خدمة العملاء", said constantly by customers). 'وجع'
// is added alongside the literal "بتوجعني" so a genuine pain report still
// matches across the many Arabic verb conjugations (وجعني/ووجعاني/هتوجعني/etc.)
// a single fixed spelling would miss — under-matching here would let a real
// severe case slip through as "routine".
const SPECIALIST_REFERRAL_KEYWORDS = [
  'كيسي', 'كيسية', 'ملتهب', 'ملتهبة', 'تورم', 'نزيف',
  'دكتور', 'دكتورة', 'متخصص', 'وجع', 'بتوجعني',
];
const SPECIALIST_REFERRAL_WORD_KEYWORDS = ['دم', 'ألم'];

function hasClinicalSeverityKeyword(text) {
  return containsAny(text, SPECIALIST_REFERRAL_KEYWORDS) || containsWord(text, SPECIALIST_REFERRAL_WORD_KEYWORDS);
}

// Replaces the model's own (rejected) hand-off line when SPECIALIST_REFERRAL
// is downgraded — never show the customer a specialist hand-off message for
// what code has determined is actually a routine case. Deliberately generic
// and product-free: rule 8 forbids inventing a product outside this turn's
// candidate list, and there's no model-authored alternative reply_text safe
// to trust here, so this keeps the conversation open for a real
// recommendation on the next turn instead of dead-ending on a false handover.
const NORMAL_CONSULTATION_FALLBACK =
  'تمام، ده موضوع عادي جدًا وهساعدك فيه زي أي استشارة تانية 💛 لو حابة تضيفي أي تفاصيل زي روتين العناية الحالي أو الميزانية التقريبية، هقدر أرشحلك أنسب منتج من عندنا فورًا.';

// 2026-08-09 — deterministic backstop for llmSystemPrompt.js's rule 8-ب
// ("never claim a product photo is/isn't available — that's only known by
// the deterministic Sheet-lookup path"). Confirmed live, chatId
// 22299554107457@lid: the model said "مفيش صورة متاحة للجيل" and separately
// "مفيش صورة متاحة لكريم صن بلوك ديرماتيك" on its own initiative — TWICE in
// the same conversation, AFTER rule 8-ب had already shipped — for a product
// that, in the second case, had a real, already-cached photo. Same two-layer
// pattern already used for SPECIALIST_REFERRAL elsewhere in this file:
// prompt-only hardening has repeatedly proven unreliable on this model for
// "never say X" rules, so a code-level catch is the actual backstop, not the
// prompt wording alone.
const PHOTO_WORD_PATTERN = /صور/;
const PHOTO_UNAVAILABILITY_PHRASES = ['مفيش', 'مش متاح', 'مش متاحه', 'لا يوجد', 'غير متاح', 'غير متاحه'].map(normalizeArabic);
const PHOTO_HALLUCINATION_SAFE_REPLY =
  'تحت أمرك 🌸 لو حابة صورة للمنتج، قوليلي "ممكن صورة" وهبعتهالك فورًا لو متاحة عندنا.';

function isPhotoAvailabilityHallucination(replyText) {
  if (!replyText) return false;
  const normalized = normalizeArabic(replyText);
  if (!PHOTO_WORD_PATTERN.test(normalized)) return false;
  return PHOTO_UNAVAILABILITY_PHRASES.some((phrase) => normalized.includes(phrase));
}

// 2026-08-09 P0 fix — confirmed live (chatId 260649351418038@lid, "ريماس
// اسلام"): she gave her full order details (name, address, alt phone) in one
// message, and the model's reply_text said "شكراً يا ريماس! هأكدلك الطلب
// دلوقتي..." (reads as an immediate confirmation) — but its own structured
// order_data.confirmed field was NOT true that turn, so applyValidatedOutput
// correctly never set orderConfirmed, session.orderPlaced stayed false, and
// NOTHING was ever written to Order History/Confirmed_Orders. She had no way
// to know anything was wrong — she was told, in plain language, that her
// order was being handled, then the conversation went quiet except for a
// cart-recovery "still interested?" nudge, which flatly contradicts what she
// was just told. Same "reply_text claims something the structured output
// doesn't back up" pattern as PHOTO_HALLUCINATION_SAFE_REPLY above, just for
// the single highest-stakes claim in this whole system. Deliberately errs
// toward over-catching (a false positive just asks the customer one extra
// confirming question, always safe) over under-catching (a false negative
// means telling a customer an order went through when it didn't).
const ORDER_CONFIRMATION_CLAIM_WORDS = [
  'هأكدلك',
  'هاكدلك',
  'تم تأكيد الطلب',
  'تم تأكيد الاوردر',
  'تم تسجيل طلبك',
  'هسجل طلبك',
  'اتسجل طلبك',
  'حجزتلك الطلب',
  'اكدتلك الطلب',
  'تم تأكيد حجزك',
].map(normalizeArabic);

function claimsOrderConfirmationInReply(replyText) {
  if (!replyText) return false;
  const normalized = normalizeArabic(replyText);
  return ORDER_CONFIRMATION_CLAIM_WORDS.some((phrase) => normalized.includes(phrase));
}

// 2026-08-09 fix: NORMAL_CONSULTATION_FALLBACK above gets saved into
// session.llm.history (see pushHistory near the bottom of handleMessage), so
// if the same downgrade fires again next turn, the model's own context now
// contains itself having just said this exact sentence, plus whatever
// concern language (real production case: anti-aging vocabulary — خطوط،
// ترهلات، انتفاخ تحت العين — misread the same way plain "حبوب" used to be
// before the 2026-07-18 acne hardening) originally tripped the false
// SPECIALIST_REFERRAL/CUSTOMER_REQUEST/LONG_CONVERSATION_UNRESOLVED
// assertion. That combination reliably reproduces the same misclassification
// turn after turn — confirmed live, a customer who gave a full skin profile
// and an explicit budget got this identical sentence 3 times in a row and
// never converted. One benign redirect is a reasonable thing to send once;
// sending the byte-identical redirect a second time means the redirect
// itself isn't working, so this is a real signal a human should take over —
// same reasoning as the existing MAX_UNCLEAR_CONFIRMATION_ATTEMPTS escalation
// in agent.js's rules-engine path, applied here for the LLM path.
const REPEATED_FALLBACK_LOOP_REASON = 'REPEATED_FALLBACK_LOOP';
const REPEATED_FALLBACK_LOOP_REPLY =
  'حاسة إن في لخبطة شوية في كلامنا 🌸 هبعتلك حد من فريقنا يتواصل معاكِ بسرعة عشان يساعدك صح.';
const MAX_CONSECUTIVE_FALLBACK_DOWNGRADES = 1;

// 2026-08-18 addition — confirmed live (chatId 88876412584107@lid, phone
// 201055990502): "every configured AI tier failed or got rejected by
// validation" (see the `if (!validated)` branch further down) used to be
// treated as a one-off blip worth silently retrying next turn, same as any
// other transient failure. But it isn't always transient — a customer
// asking about one specific product got that exact branch 5 times in ~10
// minutes because both OpenAI and Gemini kept making the identical
// structured-output mistake for that product's candidate set, a
// deterministic code/data interaction that retrying alone never recovers
// from. That branch also never recorded in session.llm.history that a
// fallback had been sent, so the model had no memory across retries that it
// had already failed — nothing could ever self-escalate.
//
// 2026-08-19 (store owner directive): raised from 1 to 5 — the original
// value handed a customer to a human after just 2 straight total-tier
// failures, which turned out to be tight enough to fire on transient
// multi-provider blips, not just genuine stuck loops. 5 gives Sara more
// room to recover on her own (each retry still carries the full
// session.llm.history, so later attempts aren't starting from scratch)
// before involving a human. Deliberately NOT the same value as
// MAX_CONSECUTIVE_FALLBACK_DOWNGRADES above — that guard is about a
// different failure shape (the model's own repeated downgraded/redirected
// replies, not hard technical failures across both AI providers) and was
// intentionally left at its own value, not raised in lockstep with this one.
const MAX_CONSECUTIVE_TIER_FAILURES = 5;

// Canonical in-memory shape is the OpenAI chat format directly —
// {role: 'user'|'assistant', content: string} — since OpenAI is now the
// primary tier. localService.js/openaiService.js consume this as-is;
// geminiService.js is the only tier with a different dialect, so it converts
// on its own side (toGeminiContents) rather than everyone converting for it.
function pushHistory(history, role, text) {
  return [...history, { role, content: text }].slice(-MAX_HISTORY_TURNS);
}

// A phone number's shape (digit-heavy, fixed rough length) is distinctive
// enough to capture safely with a plain regex even with no LLM available at
// all — unlike a name or address, which could be almost any text and would
// risk being misfiled into the wrong field if guessed blindly. Deliberately
// narrow: only fires while already mid-order-collection and only for the
// phone field, so a stray digit-only message elsewhere in the conversation
// isn't misread as an order's alt phone.
const PHONE_LIKE = /^[\d\s+()-]{8,15}$/;

function recoverOrderDataOnFailure(session, text) {
  const orderData = session.orderData || {};
  const missingAltPhone = session.stage === STAGES.AWAIT_ORDER_DETAILS && !orderData.altPhone;
  // 2026-07-18 audit: PHONE_LIKE never routed through normalizeArabic, so a
  // customer typing their alt phone in Arabic-Indic numerals (e.g. ٠١٠١٢٣...)
  // silently failed to match at all — normalizeArabic now also folds those
  // to plain digits, so this is the fix, not just a stylistic pass.
  const normalizedText = normalizeArabic(text);
  if (missingAltPhone && PHONE_LIKE.test(normalizedText)) {
    return { ...orderData, altPhone: normalizedText.trim() };
  }
  return orderData;
}

// Nullable schema fields (price_quoted, order_data.*) are sometimes filled by
// the model with the literal text "null" instead of actually omitting the
// value (observed in practice from the OpenAI fallback) — treat that as
// absent everywhere, not just where it happens to get caught. Left
// unnormalized, the literal word "null" could otherwise be stored as if it
// were a real customer name/address/phone.
function nullableString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

function sanitizeModelOutput(output) {
  if (!output) return output;
  return {
    ...output,
    price_quoted: nullableString(output.price_quoted),
    routine_bundle_suggested_id: nullableString(output.routine_bundle_suggested_id),
    routine_bundle_price_quoted: nullableString(output.routine_bundle_price_quoted),
    order_data: {
      ...output.order_data,
      customer_name: nullableString(output.order_data?.customer_name),
      delivery_address: nullableString(output.order_data?.delivery_address),
      alt_phone: nullableString(output.order_data?.alt_phone),
    },
  };
}

// Arabic diacritics vary across model outputs and product-catalog entries for
// what is otherwise the same word — strip them (plus collapse whitespace) so
// a name comparison isn't defeated by a stray fatha/kasra either side didn't
// happen to include. A handful of catalog rows (2026-08-13 audit: C142-C144,
// entered in the same Sheet batch — 12 of 269 live rows total) are also
// missing the space between a quantity and its unit, e.g. C143's real name
// "...60mL" has no space before the unit. Sara's replies always use a real
// space there, so insert one wherever a digit and an Arabic letter are
// jammed together with none — otherwise that one data-entry quirk fails this
// check (and logs a false product-id-mismatch warning) on every turn that
// names the product.
function normalizeArabicText(text) {
  return text
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/(\d)([؀-ۿ])/g, '$1 $2')
    .replace(/([؀-ۿ])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Catalog names carry a parenthetical English translation
// ("... 100 مل (Disaar Vitamin C ... 100ml)") that the model never reproduces
// in Arabic prose — compare against the Arabic portion only.
function productNameAppearsInReply(product, replyText) {
  const arabicName = normalizeArabicText(product.name.split('(')[0]);
  if (!arabicName) return false;
  return normalizeArabicText(replyText).includes(arabicName);
}

// 2026-07-18 audit: candidates used to come from searching THAT turn's raw
// text alone, with nothing carried over from earlier in the same
// consultation. Confirmed empirically to break exactly the moment the
// 4-step consultation (llmSystemPrompt.js rule 2) reaches its last step: a
// bare budget answer like "200 جنيه بس" matched unrelated products purely on
// an incidental "200 مل" size spec, and a natural "اقتصادي"/"حابة حاجة رخيصة"
// reply returned ZERO candidates — right at the turn the customer is most
// ready to buy, forcing rule 8's "the team will confirm availability"
// fallback instead of the recommendation the consultation was building
// toward. Folding in the last couple of user turns (already sitting in
// session.llm.history — no new state needed) re-introduces the skin-type/
// problem words the bare final answer alone doesn't carry.
const SEARCH_QUERY_HISTORY_WINDOW = 2;

function buildSearchQuery(session, currentText) {
  const history = (session.llm && session.llm.history) || [];
  const recentUserTurns = history
    .filter((turn) => turn.role === 'user')
    .slice(-SEARCH_QUERY_HISTORY_WINDOW)
    .map((turn) => turn.content);
  return [...recentUserTurns, currentText].filter(Boolean).join(' ');
}

// The model still needs to reference the item actually being ordered even on
// a turn whose (now rolling-window) search text doesn't happen to match it,
// so the currently-recommended product is always folded back in regardless
// — without this, order-confirmation turns get validated-rejected for
// referencing "a product outside this turn's candidate list" when that
// product is exactly the one from a prior turn the model (correctly) still
// has in mind. campaignOfferProduct (2026-08-02 audit fix) is the same idea
// applied to a campaign send: session.campaignOfferProduct is stashed by
// campaignWorker.js's appendOfferToSessionHistory when a customer receives
// an offer linked to a real catalog product, so a reply like "عايزة عرض
// مبرد القدم" is always groundable/quotable even if that exact product
// wouldn't otherwise surface from this turn's own search query.
async function selectCandidatesForTurn(text, { excludeIds = [], recommendedProduct = null, campaignOfferProduct = null, idMentionProduct = null } = {}) {
  const candidates = await productSearch.searchProducts(text, { excludeIds });
  let merged = candidates;
  // idMentionProduct (2026-08-10): a product the customer just referenced by
  // its exact catalog ID/SKU (see productIdDetector.js/productMatcher.js's
  // findByIdCandidate, resolved in handleMessage below) — guaranteed a
  // candidate this turn regardless of whether the text-search/embeddings
  // path would have surfaced it on its own, same reasoning as the two
  // existing stickies below.
  [recommendedProduct, campaignOfferProduct, idMentionProduct].forEach((sticky) => {
    if (!sticky) return;
    // Re-fetch live rather than trusting the cached session object, which is
    // a snapshot frozen at the moment it was first recommended — the 5-min
    // Sheets refresh replaces productMatcher's whole product list wholesale,
    // so a sticky candidate's own .inStock/.price never update on their own.
    // 2026-08-06 fix: this used to let an item that sold out (or had its
    // price changed) mid-conversation keep being actively re-quoted/offered
    // for the rest of that session. Dropping it here (rather than keeping it
    // with stale data) means the model simply never sees it as a candidate
    // once it's gone — it can't mention, price, or offer to confirm it.
    const live = productMatcher.getById(sticky.id);
    if (live && live.inStock !== false && !merged.some((p) => p.id === live.id)) {
      merged = [live, ...merged];
    }
  });
  return merged;
}

// Every mentioned product id must come from THIS turn's candidate list (never
// the full catalog). 2026-08-18 fix — confirmed live (chatId
// 88876412584107@lid, phone 201055990502, product "مسك الطهارة"/C048): both
// OpenAI and Gemini occasionally write a product's NAME into
// mentioned_product_ids instead of its real id — likely triggered by
// multi-scent/multi-SKU product lines (several candidates sharing most of
// their name) — and previously that discarded the ENTIRE reply, on every
// retry, for both tiers alike, since the same candidate set produces the
// same mistake. A customer asking about exactly this product got the
// generic category-menu fallback 5 times in a row and never completed her
// order. Now this only drops the bad id and keeps reply_text — the
// "mentioned id must also be named in reply_text" filter directly below
// already excludes any id that was never a real candidate (candidates.find()
// can't resolve it), so no separate filtering step is needed here.
// price_quoted is still checked digit-for-digit against a mentioned
// candidate's real price rather than scanning reply_text for any number,
// which would false-positive on legitimate non-price digits (product sizes,
// SPF ratings, etc).
function validateModelOutput(output, candidates, bundleComplement = null) {
  if (!output || typeof output.reply_text !== 'string' || !output.reply_text.trim()) return null;

  const candidateIds = new Set(candidates.map((p) => p.id));
  const rawMentionedIds = Array.isArray(output.mentioned_product_ids) ? output.mentioned_product_ids : [];
  const idsOutsideCandidates = rawMentionedIds.filter((id) => !candidateIds.has(id));
  if (idsOutsideCandidates.length > 0) {
    logger.warn(
      `LLM agent referenced product id(s) outside this turn's candidate list: ${idsOutsideCandidates.join(', ')} — dropping the bad reference(s), keeping the rest of the reply.`
    );
  }

  // Observed in production: the model sometimes tags a candidate as
  // "mentioned" that it never actually named in reply_text (e.g. wrote out a
  // 9-item list but tagged a 10th, unlisted candidate). mentioned_product_ids
  // is what drives the Product Name written to the Leads sheet, so only trust
  // ids the customer actually saw named in the reply — drop the rest rather
  // than rejecting an otherwise-good reply outright.
  const mentionedIds = rawMentionedIds.filter((id) => {
    const product = candidates.find((p) => p.id === id);
    return product && productNameAppearsInReply(product, output.reply_text);
  });
  if (mentionedIds.length !== rawMentionedIds.length) {
    const dropped = rawMentionedIds.filter((id) => !mentionedIds.includes(id));
    logger.warn(`LLM agent tagged product id(s) as mentioned that don't appear in its reply text: ${dropped.join(', ')}`);
  }

  if (output.price_quoted) {
    // normalizeArabic folds Arabic-Indic digits (e.g. "١٦٠") to plain ASCII
    // before \D strips everything else — without it, an Arabic-Indic price
    // silently stripped to an empty string and skipped verification entirely
    // (2026-07-18 audit).
    const quotedDigits = normalizeArabic(output.price_quoted).replace(/\D/g, '');
    // No digits at all (e.g. the model echoed placeholder text like "غير محدد
    // بعد" instead of leaving the field empty) isn't a fabricated price claim
    // — there's nothing numeric to have invented, so don't punish an
    // otherwise-honest reply for it. Only reject when there ARE digits that
    // don't match any mentioned candidate's real price — that's the actual
    // hallucination risk this check exists for.
    if (quotedDigits) {
      // Verify against rawMentionedIds (candidate-set membership only), NOT
      // the prose-filtered mentionedIds above — a short reply like "السعر 195
      // جنيه" can correctly state a candidate's real price without repeating
      // that candidate's full (often long, SKU-suffixed) name verbatim, and
      // checking against the narrower list was rejecting genuinely correct
      // prices whenever that happened.
      const mentioned = candidates.filter((p) => rawMentionedIds.includes(p.id));
      // 2026-08-19 fix — confirmed live (chatId 88876412584107@lid, phone
      // 201055990502): rawMentionedIds can be non-empty but resolve to ZERO
      // real candidates — the exact "model wrote the product's NAME instead
      // of its real id" defect idsOutsideCandidates already recovers from
      // above (drops the bad reference, keeps the reply). But `mentioned`
      // being empty here meant there was nothing left to verify the price
      // against, so this hard-rejected the ENTIRE reply for the same root
      // cause a second time — both AI tiers hit this on the same turn twice
      // in a row and escalated a real customer to human handoff, for a
      // price that was, in fact, real and correct. Falls back to checking
      // the quoted price against every real candidate this turn (still a
      // genuine catalog price, never an invented number) specifically when
      // the model DID attempt a mention but every one of its ids was
      // invalid — a reply that quotes a price with NO attempted mention at
      // all (rawMentionedIds empty from the start) still verifies strictly
      // against `mentioned` (empty -> always rejected), unchanged from
      // before this fix, since that case has no comparable "it tried and
      // botched the id" signal to justify the wider check.
      const attemptedInvalidMention = rawMentionedIds.length > 0 && mentioned.length === 0;
      const priceVerificationPool = attemptedInvalidMention ? candidates : mentioned;
      const verified = priceVerificationPool.some((p) => String(p.price || '').replace(/\D/g, '') === quotedDigits);
      if (!verified) {
        logger.warn(`LLM agent quoted an unverified price "${output.price_quoted}" — discarding reply.`);
        return null;
      }
    }
  }

  // Routine-bundle fields are validated the same way as price_quoted, but a
  // failure here only drops the bundle suggestion rather than discarding the
  // whole reply — it's an upsell add-on, not core order-processing
  // correctness, so being defensive (silently drop) beats being strict
  // (reject a perfectly good reply just because the bonus upsell was off).
  let routineBundleSuggestedId = output.routine_bundle_suggested_id || null;
  let routineBundlePriceQuoted = output.routine_bundle_price_quoted || null;

  if (routineBundleSuggestedId) {
    if (!bundleComplement || routineBundleSuggestedId !== bundleComplement.id) {
      logger.warn(
        `LLM agent suggested a routine bundle id "${routineBundleSuggestedId}" that wasn't offered this turn — dropping the bundle suggestion, keeping the rest of the reply.`
      );
      routineBundleSuggestedId = null;
      routineBundlePriceQuoted = null;
    } else if (routineBundlePriceQuoted) {
      const quotedDigits = normalizeArabic(routineBundlePriceQuoted).replace(/\D/g, '');
      const verified = !quotedDigits || String(bundleComplement.price || '').replace(/\D/g, '') === quotedDigits;
      if (!verified) {
        logger.warn(
          `LLM agent quoted an unverified routine-bundle price "${routineBundlePriceQuoted}" for ${bundleComplement.id} — dropping the bundle suggestion, keeping the rest of the reply.`
        );
        routineBundleSuggestedId = null;
        routineBundlePriceQuoted = null;
      }
    }
  } else {
    routineBundlePriceQuoted = null;
  }

  return {
    ...output,
    mentioned_product_ids: mentionedIds,
    routine_bundle_suggested_id: routineBundleSuggestedId,
    routine_bundle_price_quoted: routineBundlePriceQuoted,
  };
}

// 2026-08-09 fix — confirmed live (chatId 22299554107457@lid): the model's
// own mentioned_product_ids array order doesn't always match what reply_text
// actually discusses. Real example: reply_text described "صن بلوك ديرماتيك
// SPF 50" (the CREAM) by name, but mentioned_product_ids listed the GEL
// variant (a near-duplicate sibling — same product line, one extra word in
// the name) first — so the old `candidates.find(p => p.id === mentionedIds[0])`
// blindly pinned the GEL as recommendedProduct. This was a mostly invisible
// mismatch before (only affected which product got nudged later), but now
// directly determines which real product PHOTO gets sent (2026-08-09
// sheet-driven photo feature) — a silent mismatch became a visibly wrong
// answer. Never invents a new candidate: only ever reorders AMONG the ids the
// model itself already listed, using reply_text as the tiebreaker. Scores
// each mentioned candidate by what FRACTION of its own name tokens actually
// appear in reply_text (a ratio, not a raw count — a longer sibling name like
// the gel's must not automatically win just by having more tokens overall);
// only overrides the model's own ordering when there's a clear, non-tied
// winner, so an ambiguous/no-signal case is left exactly as before this fix.
function pickPrimaryMentionedProduct(mentionedIds, candidates, replyText) {
  const mentionedProducts = mentionedIds.map((id) => candidates.find((p) => p.id === id)).filter(Boolean);
  if (mentionedProducts.length <= 1) return mentionedProducts[0] || null;

  const replyNormalized = normalizeArabic(replyText || '');
  const scored = mentionedProducts.map((product) => {
    const tokens = [...new Set(normalizeArabic(product.name || '').split(' ').filter((w) => w.length >= 3))];
    const matched = tokens.filter((t) => replyNormalized.includes(t)).length;
    const ratio = tokens.length > 0 ? matched / tokens.length : 0;
    return { product, ratio };
  });

  const best = scored.reduce((a, b) => (b.ratio > a.ratio ? b : a), scored[0]);
  const tiedForBest = scored.filter((s) => s.ratio === best.ratio).length > 1;
  return tiedForBest ? mentionedProducts[0] : best.product;
}

// 2026-08-19 addition — Same-Day Express shipping. The model only ever
// states an intent (see shipping_method's schema description); this is what
// actually decides whether that intent is honored, the same "code verifies,
// model never gets the final say on a money-affecting fact" pattern already
// used for price_quoted/recommendedProductNowOutOfStock elsewhere in this
// file. 'express' is only ever accepted when the CURRENT resolved
// deliveryAddress genuinely matches a zone that has an expressFeeEGP (today,
// only cairo_giza) — never trusted just because the model claimed it, since
// a stale claim from an earlier turn (address changed since) or an outright
// model mistake would otherwise let a non-Cairo/Giza customer's order get
// tagged 'express' with nothing downstream (invoiceGenerator.js/
// orderPipeline.js) able to charge her the real 65/85/etc EGP zone fee
// instead. Falls back to 'standard' — never null — so every order has an
// unambiguous method by the time it's confirmed.
function resolveShippingMethod(requestedMethod, prevMethod, deliveryAddress) {
  const requested = requestedMethod === 'express' || requestedMethod === 'standard' ? requestedMethod : null;
  const carriedOver = prevMethod === 'express' ? 'express' : 'standard';
  const candidate = requested || carriedOver;
  if (candidate !== 'express') return 'standard';

  const zone = matchShippingZone(deliveryAddress);
  if (zone && zone.expressFeeEGP) return 'express';
  if (requested === 'express') {
    logger.warn(
      `LLM agent set shipping_method="express" for an address that doesn't resolve to an express-eligible zone ("${deliveryAddress}") — downgrading to standard.`
    );
  }
  return 'standard';
}

// 2026-08-19 addition — confirmed live (chatId 88876412584107@lid, phone
// 201055990502, Confirmed_Orders row 13): a customer ordering 12 units had
// the quantity captured only as free text — session.orderData had nowhere
// to put it — so the automated confirmation flow recorded the single-unit
// price as the whole order's total, and a human had to notice and correct
// the Sheet row after the fact. Same verify-don't-trust-verbatim pattern as
// resolveShippingMethod just above: a non-integer, zero/negative, or
// implausibly large claim is clamped back to the carried-over/default value
// rather than trusted as-is — MAX_REASONABLE_QUANTITY is a generous ceiling
// for a WhatsApp cosmetics order (not a real inventory limit), there purely
// to catch a misparse (e.g. a phone number digit string ending up here)
// before it becomes an absurd invoiced total.
const MAX_REASONABLE_QUANTITY = 200;

function resolveQuantity(rawQuantity, prevQuantity) {
  const carriedOver = Number.isInteger(prevQuantity) && prevQuantity > 0 ? prevQuantity : 1;
  if (!Number.isInteger(rawQuantity) || rawQuantity <= 0) return carriedOver;
  if (rawQuantity > MAX_REASONABLE_QUANTITY) {
    logger.warn(
      `LLM agent set an implausible order_data.quantity (${rawQuantity}) — clamping to ${carriedOver} instead of trusting it verbatim.`
    );
    return carriedOver;
  }
  return rawQuantity;
}

// Digit-only price parsing, same approach validateModelOutput's price_quoted
// check already uses — kept local rather than importing invoiceGenerator.js's
// parsePriceToNumber to avoid pulling a utils/ module into this file just for
// one line; invoiceGenerator.js itself already requires this file's
// STORE_NAME export by way of llmSystemPrompt.js, so importing back would
// risk a circular require.
function parsePriceDigitsAsNumber(price) {
  const digits = normalizeArabic(String(price || '')).replace(/\D/g, '');
  return digits ? Number(digits) : null;
}

// Code, never the model, decides order completion and human handover — both
// are re-derived here from validated fields rather than trusted as asserted.
function applyValidatedOutput(session, output, candidates, text) {
  const prevOrder = session.orderData || {};
  const deliveryAddress = output.order_data.delivery_address || prevOrder.deliveryAddress || null;
  const orderData = {
    customerName: output.order_data.customer_name || prevOrder.customerName || null,
    deliveryAddress,
    altPhone: output.order_data.alt_phone || prevOrder.altPhone || null,
    shippingMethod: resolveShippingMethod(output.order_data.shipping_method, prevOrder.shippingMethod, deliveryAddress),
    quantity: resolveQuantity(output.order_data.quantity, prevOrder.quantity),
  };

  const fieldsBefore = [prevOrder.customerName, prevOrder.deliveryAddress, prevOrder.altPhone].filter(Boolean).length;
  const fieldsAfter = [orderData.customerName, orderData.deliveryAddress, orderData.altPhone].filter(Boolean).length;
  const madeProgress = fieldsAfter > fieldsBefore;
  const orderCollectionActive = fieldsAfter > 0 || output.intent === 'ORDER_INTENT';

  const noProgressTurns = orderCollectionActive && !madeProgress ? (session.noProgressTurns || 0) + 1 : 0;

  const allFieldsPresent = Boolean(orderData.customerName && orderData.deliveryAddress && orderData.altPhone);

  // Resolve this turn's product before deciding order-completion — needed
  // to tell "the model re-asserting the SAME already-confirmed order"
  // (must stay blocked) apart from "a genuine second, different order in
  // the same session" (must NOT stay blocked — see 2026-08-06 fix below).
  // Moved up from where this used to live, right after the handover logic;
  // behavior of this block itself is unchanged.
  let recommendedProduct = session.recommendedProduct || null;
  let shownProductIds = session.shownProductIds || [];
  const mentionedIds = Array.isArray(output.mentioned_product_ids) ? output.mentioned_product_ids : [];
  if (mentionedIds.length > 0) {
    const primary = pickPrimaryMentionedProduct(mentionedIds, candidates, output.reply_text);
    if (primary) recommendedProduct = primary;
    shownProductIds = [...new Set([...shownProductIds, ...mentionedIds])];
  }

  // 2026-08-09 fix: a customer explicitly rejecting/correcting the currently
  // pinned recommendation — confirmed live, "انا لم اسأل على اى منتجات
  // لانفنتى" ("I never asked about any Infinity products") — used to leave
  // recommendedProduct pointing at the rejected item anyway, since the block
  // above only ever overwrites it on a NEW mentioned_product_ids and never
  // clears it on a negative one. cartRecovery.js's automated nudges then
  // kept re-pitching the exact product she'd just rejected, twice, with a
  // "still holding this for you" framing. output.intent === 'REJECTION' is
  // already part of the validated schema (the model already classifies
  // rejection turns correctly) but was previously only used for a log note
  // (see buildLogEntryAndNotification's default branch), never acted on.
  // Only clears when the still-pinned product isn't re-mentioned THIS turn,
  // so a customer rejecting a price or asking a follow-up about the same
  // product doesn't wrongly unpin it — stage naturally falls back to
  // AWAIT_CATEGORY below (see the stage computation further down) once
  // recommendedProduct is null, reopening the conversation for a fresh,
  // correct recommendation instead of staying stuck on the rejected one.
  if (output.intent === 'REJECTION' && recommendedProduct && !mentionedIds.includes(recommendedProduct.id)) {
    recommendedProduct = null;
  }

  // Root cause of the 2026-08-02 triple-logging incident: order fields stay
  // present in session.orderData forever once collected, and the model keeps
  // asserting order_data.confirmed=true on later turns of the same closed
  // conversation (e.g. a customer correcting phrasing after "تم تأكيد الطلب
  // بنجاح"). The original fix gated on session-wide session.orderPlaced,
  // sticky for the life of the session — which correctly blocked the
  // re-assertion case, but as an unintended side effect also permanently
  // blocked a genuinely NEW, different product ordered later in the same
  // session from ever completing (2026-08-06 audit finding: a repeat
  // purchase in one chat got no admin ping and no Order History row).
  //
  // Fix: track *which product ids* have already been confirmed this
  // session (session.confirmedProductIds) and gate on that instead, when a
  // product is actually resolved for this turn. Re-asserting order #1 for
  // the same product id stays blocked exactly as before; a different
  // product's order_data.confirmed=true is now allowed through. Only
  // falls back to the old session-wide gate when no product is resolved
  // at all (rare — order data this complete almost always has one), so
  // that edge case stays exactly as conservative as it was before this fix.
  const confirmedProductIds = session.confirmedProductIds || [];
  const isAlreadyConfirmedProduct = Boolean(recommendedProduct && confirmedProductIds.includes(recommendedProduct.id));

  // Hard backstop, independent of selectCandidatesForTurn's own out-of-stock
  // filtering above: a customer can reach "everything is filled in, please
  // confirm" on one turn and simply reply "yes" on the next without
  // re-mentioning the product, so mentionedIds (and therefore
  // recommendedProduct) can be empty on the exact turn confirmed:true
  // arrives — nothing upstream would re-check stock in that case. Re-verify
  // live here, right at the moment of completion, rather than trusting
  // whatever recommendedProduct's cached .inStock said when it was first
  // set (2026-08-06 fix — see selectCandidatesForTurn's comment for why the
  // cached object can be stale).
  // 2026-08-12 fix — confirmed live (audit found 32/34 sessions affected):
  // the catalog's ID scheme changed at some point from plain numbers ("18")
  // to "C"-prefixed SKUs ("C018"). A session pinned before that change holds
  // the old id forever (nothing ever re-resolves it), so getById(old id)
  // returns null and this out-of-stock check was treating a perfectly real,
  // in-stock product as unavailable — silently blocking order confirmation
  // for a customer who was already mid-checkout. productMatcher.findByIdCandidate
  // (built for explicit "صورة C102"-style ID mentions, see productIdDetector.js)
  // already does exactly the right reconstruction — bare digits padded
  // against whichever alphabetic-prefix+digit-width scheme is actually live
  // in the catalog — so it's reused here as a fallback rather than
  // duplicating that logic. When the fallback resolves, recommendedProduct
  // itself is updated to the live-resolved object (fresh id/price/stock/
  // imageUrl) so the session self-heals from here on instead of re-hitting
  // this same fallback every single turn.
  let recommendedProductLive = recommendedProduct ? productMatcher.getById(recommendedProduct.id) : null;
  if (recommendedProduct && !recommendedProductLive) {
    const legacyResolved = productMatcher.findByIdCandidate(recommendedProduct.id);
    if (legacyResolved) {
      recommendedProductLive = legacyResolved;
      recommendedProduct = legacyResolved;
    }
  }
  const recommendedProductNowOutOfStock = Boolean(recommendedProduct && (!recommendedProductLive || recommendedProductLive.inStock === false));

  // 2026-08-19 addition — the real, code-computed product-only total (unit
  // price x quantity), grounded the exact same way the shipping fee already
  // is (never left to the model to multiply). Uses the LIVE resolved
  // product (falling back to the cached one only if live resolution
  // failed) so this reflects the current real price, not a stale one —
  // same "never trust a cached price" reasoning as
  // recommendedProductNowOutOfStock just above. null (not 0) when there's
  // no resolvable product/price yet, so callers can tell "nothing to show"
  // apart from "a genuine free item."
  const priceSourceProduct = recommendedProductLive || recommendedProduct;
  const unitPriceNum = priceSourceProduct ? parsePriceDigitsAsNumber(priceSourceProduct.price) : null;
  const computedProductTotal = unitPriceNum !== null ? unitPriceNum * orderData.quantity : null;

  const orderConfirmed =
    allFieldsPresent &&
    output.order_data.confirmed === true &&
    !recommendedProductNowOutOfStock &&
    (recommendedProduct ? !isAlreadyConfirmedProduct : !session.orderPlaced);
  const updatedConfirmedProductIds =
    orderConfirmed && recommendedProduct ? [...new Set([...confirmedProductIds, recommendedProduct.id])] : confirmedProductIds;
  // Would have confirmed (all data present, model said confirmed:true, not
  // already-confirmed) if only the product hadn't just gone out of stock —
  // used below to swap the model's reply for an honest one instead of
  // silently not confirming while reply_text still claims success.
  const outOfStockAtConfirmation =
    allFieldsPresent && output.order_data.confirmed === true && recommendedProductNowOutOfStock && !isAlreadyConfirmedProduct;

  // 2026-08-04 zero-lock/zero-handover safeguard (store owner directive): the
  // bot must never auto-silence itself or hand off due to noProgressTurns,
  // a repeated message, or the model's own unconstrained "customer seems
  // confused/angry" judgment (the old CUSTOMER_REQUEST self-trigger,
  // persona rule 10-a — removed from the prompt, see llmSystemPrompt.js) —
  // none of those are hard evidence a customer actually needs a human. Only
  // two handover_reason values are ever trusted from the model: SPECIALIST_REFERRAL
  // (independently verified against a real clinical-severity keyword below,
  // unchanged) and the new LONG_CONVERSATION_UNRESOLVED (independently
  // verified against the actual message count further below). Any other
  // claimed reason — including CUSTOMER_REQUEST, or human_handover=true with
  // no reason at all — is never trusted from the model alone. A genuinely
  // explicit "let me talk to a human" request is still fully handled: by
  // escalationDetector.js's deterministic keyword check earlier in
  // handleMessage, which short-circuits before the LLM is ever called, not
  // by anything here.
  const claimedReason = output.human_handover === true ? output.handover_reason || null : null;
  if (output.human_handover === true && claimedReason !== 'SPECIALIST_REFERRAL' && claimedReason !== 'LONG_CONVERSATION_UNRESOLVED') {
    logger.warn(
      `LLM agent asserted human_handover=true with untrusted reason "${claimedReason || 'none'}" (customer message: "${text}") — ignoring, not a hard-evidence handover trigger.`
    );
  }
  let humanHandover = claimedReason === 'SPECIALIST_REFERRAL' || claimedReason === 'LONG_CONVERSATION_UNRESOLVED';
  let handoverReason = humanHandover ? claimedReason : null;

  // Deterministic ground-truth check (see hasClinicalSeverityKeyword above) —
  // never trust a SPECIALIST_REFERRAL assertion at face value. If the
  // customer's actual message has no real clinical severity signal, this is
  // almost certainly the over-caution bug (bare "حبوب", "عندي حبوب
  // بتضايقني", etc.), not a genuine severe/cystic case — downgrade back to a
  // normal consultation rather than handing off.
  // Ground truth is the actual text the customer is about to receive, not
  // just the structured flags — a live re-test surfaced calls where the
  // model wrote the exact SPECIALIST_REFERRAL sentence into reply_text while
  // leaving human_handover=false (an internally inconsistent structured
  // output), which would slip straight past a guard that only checked
  // handoverReason: humanHandover would already be false, so nothing would
  // look like it needed downgrading, yet the customer would still be told
  // "you need a specialist" via reply_text alone. Checking reply_text
  // directly (persona rule 10-b requires the model reproduce this sentence
  // verbatim, so matching on it is reliable) closes that gap regardless of
  // whether the model's own fields agree with its own prose.
  const SPECIALIST_REFERRAL_REPLY_MARKER = 'محتاجة متابعة من فريقنا المتخصص';
  const assertsSpecialistReferral =
    handoverReason === 'SPECIALIST_REFERRAL' ||
    (typeof output.reply_text === 'string' && output.reply_text.includes(SPECIALIST_REFERRAL_REPLY_MARKER));

  let specialistReferralDowngraded = false;
  if (assertsSpecialistReferral && !hasClinicalSeverityKeyword(text)) {
    logger.warn(
      `LLM agent asserted SPECIALIST_REFERRAL (handover_reason and/or reply_text) with no clinical severity keyword in the customer's message ("${text}") — downgrading to a normal consultation instead of handing off.`
    );
    humanHandover = false;
    handoverReason = null;
    specialistReferralDowngraded = true;
  }

  // Defensive symmetry with the SPECIALIST_REFERRAL reply-text check above:
  // the model is no longer instructed to write this exact sentence itself
  // (see llmSystemPrompt.js — CUSTOMER_REQUEST is now handled exclusively by
  // escalationDetector.js, before the LLM is ever called), but if it ever
  // does anyway (a stale fine-tune, a fallback tier trained on old data,
  // etc.), this must not reach the customer as if it were a real, verified
  // handover.
  const CUSTOMER_REQUEST_REPLY_MARKER = 'تقدر تتواصل مع خدمة العملاء الحقيقيين';
  let customerRequestReplyDowngraded = false;
  if (!humanHandover && typeof output.reply_text === 'string' && output.reply_text.includes(CUSTOMER_REQUEST_REPLY_MARKER)) {
    logger.warn(
      `LLM agent wrote the CUSTOMER_REQUEST hand-off sentence into reply_text with no trusted handover trigger (customer message: "${text}") — replacing with a normal consultation reply.`
    );
    customerRequestReplyDowngraded = true;
  }

  // 2026-08-04: LONG_CONVERSATION_UNRESOLVED is only ever legitimate once
  // this session has actually crossed the message-volume ceiling — the LLM
  // is asked to make a genuine judgment call here (see
  // buildLongConversationSection in llmSystemPrompt.js; the store owner
  // explicitly wants the model's own read of "does this customer still need
  // a human" trusted for this one case), but *eligibility* to even ask that
  // question is still deterministic and verified here, never just assumed
  // from the model's claim.
  let longConversationDowngraded = false;
  if (handoverReason === 'LONG_CONVERSATION_UNRESOLVED' && !((session.inboundMessageCount || 0) > MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION)) {
    logger.warn(
      `LLM agent asserted LONG_CONVERSATION_UNRESOLVED handover but session.inboundMessageCount (${session.inboundMessageCount || 0}) hasn't crossed ${MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION} — downgrading to a normal consultation instead of handing off.`
    );
    humanHandover = false;
    handoverReason = null;
    longConversationDowngraded = true;
  }

  // Deterministic coarse mapping onto the existing STAGES enum — purely so
  // cartRecovery.js/chatLogger keep working unchanged regardless of agent mode.
  let stage;
  if (humanHandover || orderConfirmed) stage = STAGES.CLOSED;
  else if (allFieldsPresent) stage = STAGES.AWAIT_ORDER_CONFIRMATION;
  else if (orderCollectionActive) stage = STAGES.AWAIT_ORDER_DETAILS;
  else if (recommendedProduct) stage = STAGES.RECOMMENDED;
  else stage = STAGES.AWAIT_CATEGORY;

  return {
    orderData,
    orderConfirmed,
    confirmedProductIds: updatedConfirmedProductIds,
    outOfStockAtConfirmation,
    humanHandover,
    handoverReason,
    stage,
    recommendedProduct,
    shownProductIds,
    noProgressTurns,
    specialistReferralDowngraded,
    customerRequestReplyDowngraded,
    longConversationDowngraded,
    // 2026-08-19 addition — see its own computation comment above. null when
    // there's no resolvable product/price yet.
    computedProductTotal,
  };
}

function buildLogEntryAndNotification(session, phone, text, output, applied) {
  const baseFields = baseLogFields(session, phone, text);

  if (applied.orderConfirmed) {
    // Recovery attribution: cartRecovery.js sets nudgeSentAt/secondNudgeSentAt
    // on this same session object, but never touches the Sheet itself — this
    // is the one place that later learns an order actually closed, so it's
    // the right place to note whether a nudge preceded it. Without this,
    // "did our cart-recovery nudges make money" has no answer anywhere.
    const recoveryNote = session.secondNudgeSentAt
      ? ' (بعد تذكير السلة المتروكة الثاني)'
      : session.nudgeSentAt
      ? ' (بعد تذكير السلة المتروكة)'
      : '';
    // 2026-08-09 nationwide shipping expansion — surfaced directly in the
    // admin ping so staff know the real delivery cost for fulfillment without
    // opening the invoice; null (no confident zone match) is shown honestly
    // as "needs manual check" rather than silently omitted, since a
    // fulfillment step needs SOME answer to this. 2026-08-09 policy change:
    // the free-shipping-promise override that used to sit here was removed
    // store-wide — every order always shows the real computed zone fee now.
    //
    // 2026-08-19 — Same-Day Express addition: applied.orderData.shippingMethod
    // is already re-verified against the real zone (resolveShippingMethod
    // above), so 'express' here is trustworthy — never independently
    // re-checked against expressFeeEGP a second time, that would just repeat
    // the same guard for no reason.
    const orderShippingZone = matchShippingZone(applied.orderData.deliveryAddress);
    const isExpress = applied.orderData.shippingMethod === 'express';
    const shippingFeeEGP = orderShippingZone ? (isExpress ? orderShippingZone.expressFeeEGP : orderShippingZone.feeEGP) : null;
    const shippingLine = orderShippingZone
      ? `الشحن: ${shippingFeeEGP} جنيه (${orderShippingZone.name}${isExpress ? ' — Same-Day Express' : ''})\n`
      : `الشحن: محتاج تأكيد يدوي (العنوان مطابقش منطقة معروفة)\n`;
    // 2026-08-19 addition — confirmed live (chatId 88876412584107@lid, phone
    // 201055990502, Confirmed_Orders row 13): productName/price used to
    // always be the bare single-unit values, so a multi-unit order's real
    // total silently never made it past this point — a human had to notice
    // and hand-correct the Sheet row afterward. applied.computedProductTotal
    // (unit price x quantity, computed in applyValidatedOutput) is now the
    // one true product-total value threaded everywhere downstream: Order
    // History's price column, the admin ping, and — via logEntry, same as
    // shippingMethod above — campaignWorker.js's appendConfirmedOrder, which
    // is what actually lands in Confirmed_Orders' Total Price column. Falls
    // back to the bare unit price only when nothing could be computed
    // (no resolvable product yet), matching the pre-quantity behavior exactly.
    const quantity = applied.orderData.quantity || 1;
    const productTotalDisplay =
      applied.computedProductTotal !== null
        ? String(applied.computedProductTotal)
        : applied.recommendedProduct
        ? applied.recommendedProduct.price
        : '';
    const productNameWithQuantity =
      applied.recommendedProduct && quantity > 1
        ? `${applied.recommendedProduct.name} × ${quantity}`
        : applied.recommendedProduct
        ? applied.recommendedProduct.name
        : baseFields.productName;
    const quantityLine =
      quantity > 1 && applied.recommendedProduct
        ? `الكمية: ${quantity} × ${applied.recommendedProduct.price} = ${productTotalDisplay} جنيه\n`
        : '';
    const adminNotification =
      `✅ طلب جديد مكتمل! (وكيل ذكي)\n` +
      `المنتج: ${applied.recommendedProduct ? applied.recommendedProduct.name : 'غير محدد'}\n` +
      quantityLine +
      `الاسم: ${applied.orderData.customerName || 'غير محدد'}\n` +
      `رقم العميل: ${phone}\n` +
      `رقم بديل: ${applied.orderData.altPhone || 'غير محدد'}\n` +
      `العنوان: ${applied.orderData.deliveryAddress || 'غير محدد'}\n` +
      shippingLine.trimEnd() +
      recoveryNote;
    // Order History (separate append-only sheet — see googleSheets.js) is
    // what powers the "returning customer" memory feature: unlike the Leads
    // row (upserted per-phone, so it only ever reflects the CURRENT order),
    // this is one row per completed order, so a customer's full purchase
    // history is actually recoverable later.
    const orderHistoryEntry = {
      date: new Date().toISOString(),
      customerName: applied.orderData.customerName || baseFields.customerName,
      phone,
      productName: productNameWithQuantity,
      price: productTotalDisplay,
      orderStatus: 'Completed',
    };
    return {
      logEntry: {
        ...baseFields,
        productName: productNameWithQuantity,
        customerName: applied.orderData.customerName || baseFields.customerName,
        deliveryAddress: applied.orderData.deliveryAddress || baseFields.deliveryAddress,
        // 2026-08-19 addition — threaded through to campaignWorker.js's
        // handleOrderConfirmed -> googleSheets.appendConfirmedOrder, which is
        // the only place this actually needs to land (the new "Shipping
        // Method" Confirmed_Orders column). Always 'standard' or 'express',
        // never null — resolveShippingMethod above guarantees that.
        shippingMethod: applied.orderData.shippingMethod,
        // 2026-08-19 addition — same threading purpose, for the new
        // "Quantity" Confirmed_Orders column. Always a positive integer
        // (resolveQuantity above guarantees that, default 1).
        quantity,
        orderStatus: 'Completed',
        notes: `تم تأكيد الطلب عبر الوكيل الذكي (محلي/OpenAI/Gemini)${recoveryNote}`,
      },
      adminNotification,
      orderHistoryEntry,
    };
  }

  if (applied.humanHandover) {
    // "SPECIALIST_REFERRAL" (persona rule 10-b: severe/cystic acne or an
    // explicit ask for a dermatologist) gets its own Order Status —
    // deliberately NOT "Issue", which staff already use specifically for a
    // confirmed delivery problem. Conflating the two would make staff
    // filtering by "Issue" surface skin-consultation referrals mixed in with
    // real delivery complaints.
    if (applied.handoverReason === 'SPECIALIST_REFERRAL') {
      const adminNotification =
        `🩺 حالة تحتاج متابعة متخصصة (وكيل ذكي)\n` +
        `رقم العميل: ${phone}\n` +
        `آخر رسالة: ${text}`;
      return {
        logEntry: {
          ...baseFields,
          orderStatus: 'Needs Specialist',
          notes: 'العميلة وصفت حالة جلدية تحتاج متابعة متخصصة - تم تحويلها لفريق Beauty Hub October',
        },
        adminNotification,
      };
    }

    // 2026-08-09: the model asserted a handover downgrade (SPECIALIST_REFERRAL/
    // CUSTOMER_REQUEST/LONG_CONVERSATION_UNRESOLVED) twice in a row for the
    // same session — see REPEATED_FALLBACK_LOOP_REASON's comment near the top
    // of this file. Deliberately its own branch rather than falling into the
    // LONG_CONVERSATION_UNRESOLVED text below, which would misreport this as
    // a message-count escalation when it's actually a stuck-loop one.
    if (applied.handoverReason === REPEATED_FALLBACK_LOOP_REASON) {
      const adminNotification =
        `🔁 الوكيل الذكي حوّل المحادثة لفريق بشري (رد متكرر بدون تقدم مرتين على التوالي)\n` +
        `رقم العميل: ${phone}\n` +
        `آخر رسالة: ${text}`;
      return {
        logEntry: {
          ...baseFields,
          orderStatus: resolveEarlyStageOrderStatus(applied.orderData, applied.recommendedProduct),
          notes: 'تم التحويل لفريق بشري بعد تكرار نفس الرد التلقائي مرتين متتاليتين بدون تقدم في المحادثة',
        },
        adminNotification,
      };
    }

    // Only remaining path here as of 2026-08-04 (SPECIALIST_REFERRAL has its
    // own branch above; CUSTOMER_REQUEST/noProgressTurns/repeated-message no
    // longer reach this function at all — see applyValidatedOutput).
    const adminNotification =
      `🆘 الوكيل الذكي حوّل المحادثة لفريق بشري (محادثة طويلة، تخطت ${MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION} رسالة)\n` +
      `رقم العميل: ${phone}\n` +
      `آخر رسالة: ${text}`;
    return {
      logEntry: {
        ...baseFields,
        orderStatus: resolveEarlyStageOrderStatus(applied.orderData, applied.recommendedProduct),
        notes: `تم التحويل لفريق بشري عبر الوكيل الذكي بعد ${session.inboundMessageCount || 0} رسالة من العميل`,
      },
      adminNotification,
    };
  }

  return {
    logEntry: {
      ...baseFields,
      productName: applied.recommendedProduct ? applied.recommendedProduct.name : baseFields.productName,
      orderStatus: resolveEarlyStageOrderStatus(applied.orderData, applied.recommendedProduct),
      notes: `نية العميل (وكيل ذكي): ${output.intent}`,
    },
    adminNotification: undefined,
  };
}

// Maps the Leads sheet's live Order Status to a customer-facing reply. Status
// semantics here match resolveEarlyStageOrderStatus (sessionLogHelpers.js)
// exactly, since that's what actually writes these values under AGENT_MODE=llm:
// 'Pending' = order data (name/address/alt phone/product) still being
// collected, no confirmed order yet; 'In Progress' = all of that IS collected
// but the customer hasn't given final confirmation yet — genuinely "your
// order is basically ready, just needs your yes"; 'Completed' = confirmed;
// 'Issue' = a delivery problem was reported; 'Needs Specialist' = the LLM
// referred the customer to the store's team over a severe/cystic skin
// condition or an explicit ask for a dermatologist (persona rule 10-b,
// llmSystemPrompt.js) — deliberately distinct from 'Issue' since it's a
// pre-purchase consult referral, not a delivery complaint; 'Delivered' is
// staff-set directly in the Sheet UI, never written by the bot itself.
// 'Cancelled' can only appear on rows from
// before AGENT_MODE=llm went live (the rules engine sets it; the LLM agent
// never does).
function buildOrderStatusReply(statusInfo) {
  if (!statusInfo || !statusInfo.orderStatus || statusInfo.orderStatus === 'Pending') {
    return 'لسه مفيش طلب اتأكد منك خالص 🌸 لو حابة تطلبي أو تعرفي منتجاتنا قوليلي محتاجة ايه وأنا هساعدك.';
  }

  const productNote = statusInfo.productName ? ` (${statusInfo.productName})` : '';

  switch (statusInfo.orderStatus) {
    case 'Pending - Website Order':
      return `طلبك اللي بعتيه من الموقع وصلنا فعلاً وجاري تجهيزه 🚀 فريقنا بيراجعه دلوقتي قبل الشحن، وهيتواصل معاكِ لو محتاجين أي تأكيد زيادة.`;
    case 'In Progress':
      return `بياناتك اتسجلت وطلبك${productNote} جاهز، محتاجين بس تأكيدك النهائي عشان نبدأ التجهيز 📝 تحبي تأكدي الطلب دلوقتي؟`;
    case 'Completed':
      return `تم تأكيد طلبك${productNote} وهو بيتجهز للشحن دلوقتي 📦 هيوصلك قريب ان شاء الله.`;
    case 'Delivered':
      return `طلبك${productNote} وصل واتسلم بالفعل ✅ لو في أي حاجة تانية محتاجة مساعدة فيها قوليلي.`;
    case 'Issue':
      return `في مشكلة اتسجلت على طلبك${productNote} وفريقنا هيتواصل معاكي في أقرب وقت عشان نحلها 🙏`;
    case 'Needs Specialist':
      return 'فريق Beauty Hub October هيتابع معاكي بخصوص استشارتك في أقرب وقت 🌸 لو حابة تسألي حاجة تانية دلوقتي، أنا هنا.';
    case 'Cancelled':
      return 'الطلب ده كان اتلغى. لو حابة تطلبي تاني قوليلي محتاجة ايه وهساعدك.';
    default:
      // Unknown/unexpected status value — don't guess, don't go silent.
      return 'مش قادرة أجيب حالة طلبك بالظبط دلوقتي، هبعتلك حد من فريقنا يتأكد منك في أقرب وقت.';
  }
}

// Deterministic order-status lookup (see orderStatusDetector.js) — reads the
// live Sheet rather than anything cached in the session, since Order Status
// can change from a staff edit (e.g. "Delivered") that never touches session
// state. Participates in history/logging exactly like any other turn (so the
// next AI call still has full context) but never calls an AI tier itself.
async function handleOrderStatusInquiry({ chatId, phone, trimmedText, history }) {
  const statusInfo = await googleSheets.getCurrentOrderStatus(phone);
  const reply = buildOrderStatusReply(statusInfo);

  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', reply);
  updateSession(chatId, { llm: { history: historyAfterModel } });

  return {
    reply,
    logEntry: {
      ...baseLogFields(getSession(chatId), phone, trimmedText),
      // Passing back exactly what was just read (never a guessed/different
      // value) keeps this a no-op for the column on appendLead's upsert —
      // it can never clobber a staff-set status like "Delivered".
      orderStatus: (statusInfo && statusInfo.orderStatus) || 'Pending',
      notes: `العميل سأل عن حالة الطلب - تم الرد تلقائياً من بيانات الشيت (${statusInfo ? statusInfo.orderStatus || 'غير محدد' : 'لا يوجد طلب مسجل'})`,
    },
  };
}

// Deterministic, free, no API call (see websiteOrderDetector.js for why:
// a recognized order's product/price/order-number facts are already fully
// known from the parsed text — there is nothing for an AI tier to usefully
// decide here, only hallucination risk to introduce). Logged as "Pending -
// Website Order", not "Completed" — plain WhatsApp text has no cryptographic
// link to a real completed transaction, so a human still glances at it
// before dispatch (store owner's explicit call, 2026-07-30). Note the
// website checkout flow never collects a delivery address, so the admin
// notification flags that explicitly rather than silently leaving it blank.
async function handleWebsiteOrder({ chatId, phone, trimmedText, session, order }) {
  const itemsSummary = websiteOrderDetector.summarizeItems(order.items);
  const totalLabel = order.totalPrice ? `${order.totalPrice} جنيه` : 'غير محدد';

  const reply =
    `أهلاً بيكِ 🌸 تم استلام طلبك بنجاح وجاري تجهيزه الآن 🚀\n\n` +
    `رقم الطلب: ${order.orderNumber || 'غير محدد'}\n` +
    `المنتجات: ${itemsSummary || 'غير محدد'}\n` +
    `الإجمالي: ${totalLabel}\n\n` +
    `لو محتاجة أي تفاصيل زيادة أو حابة تتابعي حالة الطلب، أنا هنا 🌸`;

  const history = (session.llm && session.llm.history) || [];
  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', reply);

  updateSession(chatId, {
    websiteOrder: { ...order, itemsSummary, receivedAt: Date.now() },
    stage: STAGES.CLOSED,
    noProgressTurns: 0,
    customerName: order.customerName || session.customerName,
    llm: { history: historyAfterModel },
  });

  const adminNotification =
    `🛒 طلب جديد من الموقع (Pending — يحتاج مراجعة قبل الشحن)\n` +
    `رقم الطلب: ${order.orderNumber || 'غير محدد'}\n` +
    `الاسم: ${order.customerName || 'غير محدد'}\n` +
    `التليفون: ${order.phone || phone}\n` +
    `المنتجات: ${itemsSummary || 'غير محدد'}\n` +
    `الإجمالي: ${totalLabel}\n` +
    `⚠️ الموقع مبيجمعش عنوان التوصيل — لازم ياخده حد من الفريق من العميلة قبل الشحن.` +
    (order.orderNotes ? `\nملاحظات العميلة: ${order.orderNotes}` : '');

  return {
    reply,
    logEntry: {
      ...baseLogFields(getSession(chatId), phone, trimmedText),
      customerName: order.customerName || session.customerName || '',
      productName: itemsSummary,
      altPhone: order.phone && order.phone !== phone ? order.phone : '',
      orderStatus: 'Pending - Website Order',
      notes:
        `طلب من الموقع — رقم الطلب ${order.orderNumber || 'غير محدد'}, يحتاج مراجعة قبل الشحن (مفيش عنوان توصيل من الموقع).` +
        (order.orderNotes ? ` ملاحظات العميلة: ${order.orderNotes}` : ''),
    },
    adminNotification,
  };
}

// Deterministic, free, no API call — same reasoning as escalation/delivery-
// feedback/order-status above: whether a confirmed order gets cancelled must
// decide a real Sheet status write and page the admin, so it must never
// depend on the model merely saying "cancelled" in reply_text with nothing
// behind it. That gap was exactly the 2026-08-06 audit's root-cause finding:
// buildOrderStatusReply's 'Cancelled' case already existed (for when a
// customer later asks "where's my order" post-cancellation), but nothing in
// the live path ever produced that status — the LLM's reply was purely
// conversational, so a cancelled-by-the-customer order still sat in the
// Sheet as a live, confirmed order for staff/delivery. Only armed once
// session.orderPlaced is true (see ORDER_CANCELLATION_REQUEST_KEYWORDS in
// prompts.js for why this list is narrower than ORDER_CANCEL_KEYWORDS).
async function handleOrderCancellationRequest({ chatId, phone, trimmedText, session }) {
  await googleSheets.updateOrderStatus(phone, 'Cancelled');

  const history = (session.llm && session.llm.history) || [];
  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', MESSAGES.orderCancelled);
  updateSession(chatId, {
    orderPlaced: false,
    llm: { history: historyAfterModel },
  });

  const adminNotification =
    `❌ عميل لغى طلب مؤكد (وكيل ذكي)\n` +
    `رقم العميل: ${phone}\n` +
    `رسالته: ${trimmedText}`;

  return {
    reply: MESSAGES.orderCancelled,
    logEntry: {
      ...baseLogFields(getSession(chatId), phone, trimmedText),
      orderStatus: 'Cancelled',
      notes: 'العميل طلب إلغاء طلب مؤكد - تم تحديث حالة الطلب في الشيت مباشرة',
    },
    adminNotification,
  };
}

// Generic photo-request/filler words to ignore when looking for a
// "distinguishing" token below — without this, the trigger words themselves
// (e.g. "صورة") could coincidentally overlap a candidate product's name and
// cause a wrong override. Deliberately just the common short filler set, not
// an exhaustive stopword list — this only needs to strip the words this
// exact feature's own vocabulary introduces.
const PHOTO_REQUEST_FILLER_WORDS = new Set(
  ['صوره', 'صور', 'محتاج', 'محتاجه', 'عايز', 'عايزه', 'ممكن', 'دا', 'دي', 'كمان', 'عندك', 'عندكم', 'ورينى', 'وريني', 'وريها'].map(normalizeArabic)
);

// 2026-08-09 addition, confirmed against real production data: Egyptian
// customers commonly type "جيل" for "gel" (colloquial spelling) even when the
// catalog itself consistently spells it "جل" — verified by checking all 45
// real "gel" products in the live Products sheet, 100% spelled "جل", 0%
// "جيل". A plain substring match alone would silently miss this real case
// (confirmed live, chatId 22299554107457@lid, 2026-08-09 — see
// findNamedAlternativeProduct's header comment for the full story). Kept as
// a small explicit table, not a general fuzzy-match algorithm, so this stays
// predictable and easy to extend if another confusable pair turns up.
const PRODUCT_TOKEN_ALIASES = { [normalizeArabic('جيل')]: normalizeArabic('جل') };

// Strips a leading Arabic definite article ("ال") before alias lookup/
// matching — "الجيل"/"الجل" (as typed by a customer, with the article
// attached) otherwise never matches either PRODUCT_TOKEN_ALIASES' bare
// "جيل" key or a candidate product name's bare "جل" (product names are
// almost never typed mid-sentence with the article attached). Length guard
// avoids mangling short unrelated words that happen to start with the same
// two letters — kept at >= 4 (not > 4, a real 2026-08-09 bug caught live:
// "الجل" is exactly 4 characters, so a stricter ">4" guard silently left it
// un-stripped and broke the single-message case "صورة الجل" entirely).
function stripDefiniteArticle(token) {
  return token.length >= 4 && token.startsWith('ال') ? token.slice(2) : token;
}

// Minimum name-token overlap with the PINNED product's own name for another
// product to even be considered a candidate "variant" of it below — tuned
// against the real catalog (2026-08-09): the true gel/cream sibling pair
// shares 7 tokens ("بلوك"/"ديرماتيك"/"dermatique"/"sunblock"/"spf"/"50"...),
// while unrelated same-category products sharing the pin's generic form-word
// (e.g. "كريم") but nothing else typically share 0-1. 2 is a deliberately low
// floor that still excludes those near-misses on this real data.
const MIN_SHARED_TOKENS_FOR_VARIANT = 2;

// A token common across many product names (generic form-words like
// "كريم"/"غسول") is a weak, unreliable signal for "this names a specific
// product" — trusting it returns unrelated products. Tuned against the real
// live catalog (2026-08-12): "كريم" appears in 45 product names, "غسول" in
// 24, "جل" in 23 (out of 269) — all clearly generic — while real brand/
// product identifiers like "بلانكي"/"blankie" (1), "ديرماتيك"/"dermatique"
// (4-6) are rare. 10 sits well below the generic cluster and above the real
// brand-name cluster on this data. namesNormalized is the caller's own
// productMatcher.getAllProducts() names (pre-normalized) so this never
// re-scans/re-normalizes the catalog per token.
const MAX_PRODUCTS_FOR_DISTINCTIVE_TOKEN = 10;
function isDistinctiveToken(token, namesNormalized) {
  const count = namesNormalized.filter((name) => name.includes(token)).length;
  return count > 0 && count <= MAX_PRODUCTS_FOR_DISTINCTIVE_TOKEN;
}

// 2026-08-09 addition — confirmed live (chatId 22299554107457@lid): a
// customer asked for the pinned product's photo, then said "دا الكريم محتاج
// صوره الجيل" (asking for the GEL variant instead of the pinned CREAM
// variant) and kept getting the cream's photo both times, since
// handleProductImageRequest always trusted session.recommendedProduct
// wholesale.
//
// Two approaches were tried and measured against the real catalog before
// landing on this one:
// 1. Running the customer's full free-text message through the general
//    semantic/keyword product search and trusting its top hit over the pin —
//    rejected: on messy phrasing like the example above it returned
//    unrelated products more often than the right one.
// 2. Scoring EVERY same-category product by how many "distinguishing"
//    message tokens (generic filler words and anything already in the
//    pinned name excluded) appear in its name — rejected after testing:
//    generic descriptive words like "كريم" (cream) are exactly the words a
//    customer uses to refer back to what's ALREADY pinned, not to name
//    something new, and they matched an unrelated product
//    ("كولاجرا صن سكرين جل كريم") higher than the actual intended sibling.
//
// This version fixes that by scoring in two stages: first restrict candidates
// to real "variant siblings" of the pin — other products in the same
// category whose OWN name substantially overlaps the pinned product's name
// (MIN_SHARED_TOKENS_FOR_VARIANT) — which, verified against the real
// catalog, tightly isolates same-product-line variants (a gel/cream pair
// shares 7 tokens; unrelated products sharing only a generic word share at
// most 1). Only THEN is that narrow pool scored by the message's
// distinguishing tokens to pick which sibling. No match at either stage
// falls through to the pin unchanged, same as before this fix — this can
// only ever narrow toward a real, catalog-verified sibling, never toward an
// arbitrary product.
function findNamedAlternativeProduct(text, pinnedProduct) {
  if (!pinnedProduct) return null;
  const catalog = productMatcher.getAllProducts();
  const namesNormalized = catalog.map((p) => normalizeArabic(p.name || ''));

  const pinnedNameTokensRaw = normalizeArabic(pinnedProduct.name || '')
    .split(' ')
    .filter((w) => w.length >= 3);
  if (pinnedNameTokensRaw.length === 0) return null;
  // 2026-08-12 fix — confirmed live: for a pinned product whose name is
  // mostly generic cleanser-boilerplate ("ديرماتيك غسول للبشرة الدهنية
  // والمختلطة"), the un-filtered version of this check let a completely
  // unrelated product ("كولا جرا غسول جل للبشرة الدهنية...") count as a
  // "variant sibling" purely because it also contains "غسول"/"للبشرة
  // الدهنية" — generic words shared by dozens of unrelated cleansers, not a
  // real sign of the same product line. Only the pin's OWN distinctive
  // tokens (e.g. "ديرماتيك") now count toward "is this really a variant of
  // the pin" — same distinctiveness check used below for the full-catalog
  // search. Verified this still passes the original gel/cream case (shares
  // "ديرماتيك"/"dermatique" alone already clears MIN_SHARED_TOKENS_FOR_VARIANT).
  const pinnedNameTokens = pinnedNameTokensRaw.filter((t) => isDistinctiveToken(t, namesNormalized));
  if (pinnedNameTokens.length === 0) return null;

  const messageTokens = normalizeArabic(text)
    .split(' ')
    .filter((w) => w.length >= 3)
    .map(stripDefiniteArticle)
    .map((w) => PRODUCT_TOKEN_ALIASES[w] || w)
    .filter((w) => !PHOTO_REQUEST_FILLER_WORDS.has(w) && !pinnedNameTokensRaw.includes(w));
  if (messageTokens.length === 0) return null;

  const siblings = catalog
    .filter((p) => p.id !== pinnedProduct.id && p.inStock !== false && p.category === pinnedProduct.category)
    .map((p) => {
      const nameNormalized = normalizeArabic(p.name || '');
      const sharedWithPin = pinnedNameTokens.filter((t) => nameNormalized.includes(t)).length;
      return { product: p, nameNormalized, sharedWithPin };
    })
    .filter((entry) => entry.sharedWithPin >= MIN_SHARED_TOKENS_FOR_VARIANT);

  let best = null;
  let bestScore = 0;
  for (const entry of siblings) {
    const score = messageTokens.filter((t) => entry.nameNormalized.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = entry.product;
    }
  }
  return best;
}

// 2026-08-12 fix — confirmed live (chatId 22299554107457@lid): a customer
// asked for a photo of "بلانكي" (an entirely different brand never before
// mentioned in the conversation) while a "ديرماتيك" product was still
// pinned from earlier. findNamedAlternativeProduct above only ever
// considers same-category products that share DISTINCTIVE name tokens WITH
// THE PIN (real "variant siblings" like the gel/cream pair) — "بلانكي"
// shares zero tokens with "ديرماتيك", so it never entered that search at
// all, and handleProductImageRequest silently kept sending the stale pinned
// product's photo. This is a genuinely different situation from the variant
// case: the customer is naming a brand-new product, not disambiguating
// between two forms of the one already pinned — so this searches the FULL
// catalog (every category, not just the pin's) rather than restricting to
// siblings-of-the-pin. Reuses isDistinctiveToken (same threshold/reasoning
// as findNamedAlternativeProduct above) so a generic message word can't
// false-match an unrelated product here either.
function findNamedProductInFullCatalog(text, excludeId) {
  const messageTokens = normalizeArabic(text)
    .split(' ')
    .filter((w) => w.length >= 3)
    .map(stripDefiniteArticle)
    .map((w) => PRODUCT_TOKEN_ALIASES[w] || w)
    .filter((w) => !PHOTO_REQUEST_FILLER_WORDS.has(w));
  if (messageTokens.length === 0) return null;

  const catalog = productMatcher.getAllProducts().filter((p) => p.id !== excludeId && p.inStock !== false);
  const namesNormalized = catalog.map((p) => normalizeArabic(p.name || ''));

  const distinctiveTokens = messageTokens.filter((t) => isDistinctiveToken(t, namesNormalized));
  if (distinctiveTokens.length === 0) return null;

  let best = null;
  let bestScore = 0;
  catalog.forEach((p, i) => {
    const score = distinctiveTokens.filter((t) => namesNormalized[i].includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  });
  return best;
}

// Deterministic, free, no API call — same reasoning as every other detector
// above: which image (if any) reaches the customer must never depend on the
// LLM's judgment, since it's strictly sheet-driven (Products!Image URL,
// 2026-08-09 addition) and must never send an arbitrary/guessed image or a
// broken link. Prefers the product already pinned this conversation
// (session.recommendedProduct) so "show me a picture" mid-consultation means
// exactly the item Sara just recommended — unless the message itself names a
// different real product (see findNamedAlternativeProduct above); only falls
// back to a fresh general search when nothing is pinned yet (e.g. the very
// first message is a photo request). Re-reads the live catalog via
// productMatcher.getById rather than trusting the session's possibly-stale
// cached copy, so a staff member filling in the Image URL column after a
// product was already recommended takes effect on the customer's very next
// request, not just future ones.
async function handleProductImageRequest({ chatId, phone, trimmedText, session, idMentionProduct = null }) {
  const history = (session.llm && session.llm.history) || [];
  let product = null;
  let newlyFound = false;

  // 2026-08-10: an explicit catalog ID/SKU in the same message (e.g. "صورة
  // C102") is a stronger, more authoritative signal than the pinned-product
  // recovery/variant-matching chain below — it's an exact match against the
  // real catalog, not an inference from conversation history — so it takes
  // priority over all of that rather than only being considered as a
  // last-resort fallback.
  if (idMentionProduct) {
    product = idMentionProduct;
    newlyFound = true;
  } else if (session.recommendedProduct && session.recommendedProduct.id) {
    // 2026-08-12: same legacy plain-numeric-id fallback as applyValidatedOutput's
    // out-of-stock check above — without it, a session pinned before the
    // catalog's id-scheme change falls all the way back to the stale cached
    // session.recommendedProduct object (old price/imageUrl/stock), instead
    // of the live catalog entry findByIdCandidate can still resolve it to.
    const pinned = productMatcher.getById(session.recommendedProduct.id) || productMatcher.findByIdCandidate(session.recommendedProduct.id) || session.recommendedProduct;
    product = pinned;

    // 2026-08-09 fix — confirmed live (chatId 22299554107457@lid), a deeper
    // issue than the gel/cream variant case below: session.recommendedProduct
    // can go stale or point at a completely UNRELATED product whenever the
    // model's mentioned_product_ids doesn't match what its own reply_text
    // just said (see pickPrimaryMentionedProduct's comment for the general
    // mechanism — this was observed live going wrong in more than one way
    // across a single long conversation). Concretely: a customer picked
    // "غسول ديرماتيك للبشرة الدهنية والمختلطة" by name, Sara's own reply
    // confirmed exactly that product, yet the customer's next photo request
    // sent a totally different, unrelated cleanser's photo instead. Ground-
    // truth check: does the pinned product's name even appear in Sara's own
    // LAST reply? If not, it's likely stale — attempt to recover the product
    // actually just discussed by checking session.shownProductIds (every real
    // product genuinely surfaced this conversation, including ones the model
    // tagged in mentioned_product_ids even when it mis-picked which one to
    // PIN as primary — see pickPrimaryMentionedProduct, which still records
    // every tagged id into shownProductIds regardless of ordering). First
    // attempt used a fresh productSearch.searchProducts() call instead —
    // tested against the real failing case and rejected: the rolling
    // SEARCH_QUERY_HISTORY_WINDOW (2 user turns) is too narrow to still
    // contain the identifying text several turns after a numbered-list pick
    // like "رقم ٣", so the search came back empty. Checking shownProductIds is
    // both more precise (a curated pool of real, already-discussed products
    // for THIS session, not a fuzzy full-catalog search) and synchronous (no
    // extra API call). Only ever trusted if the candidate's name is itself
    // confirmed present in that same last reply — a generic follow-up that
    // doesn't name ANY product ("تحبي تحجزيه؟") finds no confirmed candidate
    // either, so the original pin is safely left unchanged. This can only
    // ever correct a clear, positively-confirmed mismatch, never introduce a
    // new one.
    const lastAssistantTurn = [...history].reverse().find((turn) => turn.role === 'assistant');
    if (lastAssistantTurn && !productNameAppearsInReply(pinned, lastAssistantTurn.content)) {
      const shownProducts = (session.shownProductIds || []).map((id) => productMatcher.getById(id)).filter(Boolean);
      const confirmed = shownProducts.find((p) => productNameAppearsInReply(p, lastAssistantTurn.content));
      if (confirmed && confirmed.id !== pinned.id) {
        product = confirmed;
        newlyFound = true;
      }
    }

    // 2026-08-09 fix — confirmed live (chatId 22299554107457@lid): a customer
    // named the variant they wanted ("الجل") in one message, then asked for
    // the photo ("مفيش صوره بيه") in a separate, LATER message that doesn't
    // repeat the product word at all. Checking trimmedText alone (this
    // turn's message only) can never resolve that — reuses buildSearchQuery's
    // existing rolling-window (last SEARCH_QUERY_HISTORY_WINDOW user turns),
    // the same pattern already trusted elsewhere in this file for "carry
    // recent context forward", so a distinguishing word from a recent turn
    // still counts even when the photo-request turn itself is bare.
    const alternative = findNamedAlternativeProduct(buildSearchQuery(session, trimmedText), product);
    if (alternative) {
      product = alternative;
      newlyFound = true;
    } else {
      // 2026-08-12: the message may name a completely different product
      // (not a same-line variant of the pin) — see
      // findNamedProductInFullCatalog's header comment for the real bug
      // this closes.
      const distinctProduct = findNamedProductInFullCatalog(buildSearchQuery(session, trimmedText), product.id);
      if (distinctProduct) {
        product = distinctProduct;
        newlyFound = true;
      }
    }
  }

  if (!product) {
    const candidates = await productSearch.searchProducts(trimmedText, { limit: 1 });
    if (candidates[0]) {
      product = candidates[0];
      newlyFound = true;
    }
  }

  if (!product) {
    const reply = MESSAGES.askWhichProductImage;
    const historyAfterUser = pushHistory(history, 'user', trimmedText);
    const historyAfterModel = pushHistory(historyAfterUser, 'assistant', reply);
    updateSession(chatId, { llm: { history: historyAfterModel } });
    return {
      reply,
      logEntry: {
        ...baseLogFields(getSession(chatId), phone, trimmedText),
        notes: 'العميلة طلبت صورة منتج بدون تحديد أو ترشيح سابق',
      },
    };
  }

  const reply = product.imageUrl ? productImageReply(product.name) : productImageNotAvailable(product.name);

  const historyAfterUser = pushHistory(history, 'user', trimmedText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', reply);
  updateSession(chatId, {
    llm: { history: historyAfterModel },
    recommendedProduct: newlyFound ? product : session.recommendedProduct,
    shownProductIds: newlyFound
      ? [...new Set([...(session.shownProductIds || []), product.id])]
      : session.shownProductIds,
  });

  const logEntry = {
    ...baseLogFields(getSession(chatId), phone, trimmedText),
    notes: product.imageUrl
      ? `العميلة طلبت صورة المنتج "${product.name}" — تم إرسالها من رابط الشيت`
      : `العميلة طلبت صورة المنتج "${product.name}" لكن مفيش رابط صورة مسجل في الشيت لسه`,
  };

  if (!product.imageUrl) {
    return { reply, logEntry };
  }

  return {
    reply,
    logEntry,
    // Consumed by whatsapp/client.js to actually send the photo — this
    // module never touches WhatsApp/MessageMedia directly. productId feeds
    // productImageCache.js's local disk cache (2026-08-09) so the SAME
    // product's photo is served from disk, not re-fetched from the external
    // host, on every request after the first.
    productImage: { url: product.imageUrl, productName: product.name, productId: product.id },
  };
}

async function handleMessage({ chatId, phone, text, senderName, imageContext }) {
  const session = getSession(chatId);
  // Captured before anything this turn touches the session — updateSession()
  // stamps a fresh updatedAt on every call below, so this is the one true
  // "how long has this customer been away" reading for buildCustomerProfile.
  const previousUpdatedAt = session.updatedAt;
  // Deliberately what the customer actually TYPED, and nothing else — every
  // deterministic intent detector below (escalation, order status/
  // cancellation, product-image request, etc.) reads this, never modelText.
  // 2026-08-09 vision feature: keeping this separate from modelText matters —
  // a photo's Vision-generated description (imageContext) is free text that
  // routinely contains words like "صورة" itself (describing a photo
  // necessarily uses the word for "photo"), which would otherwise
  // false-trigger productImageRequestDetector on every single analyzed
  // incoming image, or in principle collide with any other keyword list here
  // (escalationDetector, orderStatusDetector, ...). Caught before shipping by
  // tracing exactly this collision, not from a live incident.
  const trimmedText = (text || '').trim();
  // What the AI tiers/conversation history/candidate search actually see —
  // customer's text plus a plain-language marker of what Sara "saw" in their
  // photo, so product recommendations and replies can genuinely react to
  // photo content while every deterministic branch above stays governed only
  // by trimmedText. See visionService.js for why the vision model itself
  // never talks to the customer directly — this is still just a string
  // flowing through the exact same guardrails as typed text.
  const modelText = imageContext
    ? trimmedText
      ? `${trimmedText}\n[صورة مرفقة من العميلة — وصف تلقائي للصورة: ${imageContext}]`
      : `[صورة مرفقة من العميلة — وصف تلقائي للصورة: ${imageContext}]`
    : trimmedText;

  // Deterministic Product ID/SKU recognition (2026-08-10) — a customer
  // quoting a catalog ID/SKU directly (from the new public catalog page, or
  // a code read out by staff) must resolve to that EXACT product, never a
  // guess from text/embedding search. Resolved once per turn, from
  // trimmedText only (an ID is something a customer types, never something a
  // photo's Vision description can contain) — same trimmedText-only
  // discipline as every other deterministic detector above. Only the first
  // candidate token that resolves to a real, in-stock product is used; a
  // number/token that doesn't match anything real is silently ignored
  // (falls through to the normal search flow below) rather than telling the
  // customer "not found" for what might just be an unrelated number in
  // their message — see productIdDetector.js for why bare numbers require an
  // explicit "كود"/"منتج...رقم"/"#" marker before being treated as an id at
  // all (avoids colliding with a customer picking "رقم ٣" off a numbered
  // list, a real failure mode this codebase already had to fix once).
  let idMentionProduct = null;
  for (const candidate of productIdDetector.extractProductIdCandidates(trimmedText)) {
    const match = productMatcher.findByIdCandidate(candidate);
    if (match && match.inStock !== false) {
      idMentionProduct = match;
      break;
    }
  }

  // 2026-08-04 zero-lock safeguard: counts every real inbound customer
  // message toward the >60-message long-conversation threshold (see
  // MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION below) — incremented here,
  // before any other branch, so it reflects true message volume regardless
  // of which code path eventually handles this turn (escalation/repetition/
  // website-order/delivery-feedback short-circuits all still count). Reset
  // on a new episode (same 6h gap boundary buildCustomerProfile already
  // uses below) so "a single session" doesn't mean "this customer's entire
  // lifetime history with the store".
  const isNewEpisode = !previousUpdatedAt || Date.now() - previousUpdatedAt > NEW_EPISODE_GAP_MS;
  const inboundMessageCount = isNewEpisode ? 1 : (session.inboundMessageCount || 0) + 1;
  updateSession(chatId, { inboundMessageCount });

  if (session.nudgeSentAt) {
    updateSession(chatId, { nudgeSentAt: null });
  }

  // 2026-08-04 addition — Meta "Click-to-WhatsApp" ad landing. Deterministic,
  // free, no API call, same reasoning as every other detector here: whether
  // this conversation starts already grounded in a specific real product
  // must never depend on the LLM happening to notice the ad text itself.
  // Only checked once per session (session.adLandingCampaignId guards it) —
  // a returning customer chatting about something else later must never have
  // their in-progress conversation reset back to the ad's product just
  // because campaignWorker.tagAdLead's own independent detection call
  // matched the same stored text again. adLandingPending drives one proactive
  // greeting turn in the system prompt (see buildSystemPrompt's adLanding
  // param) and is cleared right after that reply is generated below.
  if (!session.adLandingCampaignId) {
    const adCampaign = adLeadDetector.detectAdCampaign(trimmedText);
    if (adCampaign) {
      const adProduct = adCampaign.productId ? productMatcher.getById(adCampaign.productId) : null;
      updateSession(chatId, {
        adLandingCampaignId: adCampaign.id,
        adLandingPending: true,
        recommendedProduct: adProduct || session.recommendedProduct,
        category: adProduct ? adProduct.category : session.category,
      });
    }
  }

  // Deterministic, free, no API call — an explicit ask for a human must never
  // depend on the LLM correctly reading it as a handover every time.
  if (escalationDetector.isEscalationRequest(trimmedText)) {
    updateSession(chatId, {
      humanHandover: true,
      humanHandoffAt: Date.now(),
      stage: STAGES.CLOSED,
      noProgressTurns: 0,
      orderPlaced: false,
    });
    return buildEscalationResponse(getSession(chatId), phone, trimmedText);
  }

  // Deterministic repetition tracking (2026-08-02) — a customer repeating
  // their exact previous message verbatim is checked against session state
  // as it stood BEFORE this turn (session.llm.history hasn't been updated
  // with trimmedText yet). normalizeArabic keeps this in sync with how
  // digit/text comparisons elsewhere in this file are normalized, so trivial
  // Arabic-Indic-digit or whitespace differences don't defeat it. 2026-08-04
  // zero-lock safeguard: this used to force a handover on the 3rd repeat —
  // removed (repeating yourself isn't hard evidence a human is needed); the
  // counter now only drives the soft one-time prompt nudge below
  // (consecutiveRepeats === 1), never a forced silence.
  const priorUserTurns = ((session.llm && session.llm.history) || []).filter((turn) => turn.role === 'user');
  const lastUserText = priorUserTurns.length > 0 ? priorUserTurns[priorUserTurns.length - 1].content : null;
  const isRepeatedMessage = Boolean(trimmedText && lastUserText && normalizeArabic(lastUserText).trim() === normalizeArabic(trimmedText).trim());
  const consecutiveRepeats = isRepeatedMessage ? (session.consecutiveRepeats || 0) + 1 : 0;

  // Deterministic, free, no API call — see websiteOrderDetector.js. Checked
  // early, same priority tier as escalation above: a recognized website
  // order is a very specific structural signal that should short-circuit
  // immediately rather than fall through to the general LLM flow.
  const websiteOrder = websiteOrderDetector.parseWebsiteOrder(trimmedText);
  if (websiteOrder) {
    return handleWebsiteOrder({ chatId, phone, trimmedText, session, order: websiteOrder });
  }

  // 2026-08-09 order-management pipeline (see orderPipeline.js). A
  // confirmation-request left unanswered for 48h+ is stale — a reply days
  // later must not be misread as an order confirmation. Expire it and fall
  // through to normal handling below.
  if (isOrderConfirmationReplyExpired(session)) {
    updateSession(chatId, { awaitingOrderConfirmationReply: false, orderConfirmationRequestedAt: null, pendingConfirmedOrderRow: null });
  }

  // Deterministic, free, no API call — same reasoning as the escalation
  // check above: whether Confirmed_Orders' Confirmation Status flips to
  // 'Confirmed'/'Rejected' must never depend on the LLM correctly reading
  // intent every time. Only runs when orderPipeline.js actually sent the
  // confirmation-request message for this customer — never fires on
  // ordinary chat. Rejection is checked BEFORE confirmation — see
  // orderConfirmationReplyDetector.js's 2026-08-10 note: "مش تمام" ("not
  // OK") contains the standalone word "تمام" and would otherwise
  // false-match the confirmation check.
  if (session.awaitingOrderConfirmationReply) {
    if (orderConfirmationReplyDetector.isOrderRejectionReply(trimmedText)) {
      const rowNumber = session.pendingConfirmedOrderRow;
      await googleSheets.setConfirmationStatus(rowNumber, 'Rejected');
      const reply = MESSAGES.orderCancelled;
      const history = (session.llm && session.llm.history) || [];
      const historyAfterModel = pushHistory(pushHistory(history, 'user', trimmedText), 'assistant', reply);
      updateSession(chatId, {
        awaitingOrderConfirmationReply: false,
        orderConfirmationRequestedAt: null,
        pendingConfirmedOrderRow: null,
        llm: { history: historyAfterModel },
      });
      const adminNotification =
        `❌ عميل رفض تأكيد أوردر (Confirmed_Orders row ${rowNumber})\n` +
        `رقم العميل: ${phone}\n` +
        `رسالته: ${trimmedText}`;
      return {
        reply,
        logEntry: {
          ...baseLogFields(getSession(chatId), phone, trimmedText),
          notes: `العميل رفض الأوردر (Confirmed_Orders row ${rowNumber}) عن طريق رد رفض تلقائي`,
        },
        adminNotification,
      };
    }
    if (orderConfirmationReplyDetector.isOrderConfirmationReply(trimmedText)) {
      const rowNumber = session.pendingConfirmedOrderRow;
      await googleSheets.setConfirmationStatus(rowNumber, 'Confirmed');
      const reply = 'تمام يا قمر، تم تأكيد طلبك! 🌸 هيوصلك قريب.';
      const history = (session.llm && session.llm.history) || [];
      const historyAfterModel = pushHistory(pushHistory(history, 'user', trimmedText), 'assistant', reply);
      updateSession(chatId, {
        awaitingOrderConfirmationReply: false,
        orderConfirmationRequestedAt: null,
        pendingConfirmedOrderRow: null,
        llm: { history: historyAfterModel },
        // 2026-08-19 fix — confirmed live (chatId 201335517540524@lid, phone
        // 201212162308, Confirmed_Orders row 11): this deterministic
        // confirmation path flips the Sheet's Confirmation Status but never
        // used to touch session.orderPlaced, unlike applyValidatedOutput's
        // own order-confirmation path (see its orderConfirmed handling
        // above), which does. cartRecovery.js's scanAndSendNudges gates
        // solely on `if (session.orderPlaced) continue;` — so a customer who
        // confirms via a plain "تمام"/"تأكيد" reply to the order-pipeline's
        // ask (a common, arguably the MOST common, confirmation path) stayed
        // permanently nudge-eligible for the rest of her relationship with
        // the store: her coarse `stage` keeps recomputing into a
        // NUDGE_ELIGIBLE_STAGES bucket since orderData/recommendedProduct
        // stay populated, and orderPlaced never flips true to stop it. Not a
        // cart-recovery bug — cartRecovery.js's one-shot-per-episode design
        // (2026-08-11) is working exactly as intended; this is what was
        // silently defeating its own "already ordered" guard. Setting it
        // true here, matching the other confirmation path, is what actually
        // stops future nudges for every customer who confirms this way, not
        // just this one.
        orderPlaced: true,
      });
      return {
        reply,
        logEntry: {
          ...baseLogFields(getSession(chatId), phone, trimmedText),
          notes: `العميل أكد الأوردر (Confirmed_Orders row ${rowNumber}) عن طريق رد تأكيد تلقائي`,
        },
      };
    }
    // No match — fall through to the normal LLM flow below.
    // buildSystemPrompt's awaitingOrderConfirmationReply param tells Sara to
    // gently ask for تأكيد/تمام rather than assume either way, and
    // session.awaitingOrderConfirmationReply stays true so the next reply
    // gets another chance at deterministic matching.
  }

  // Same pattern as above, for the delivery+rating-request message
  // (orderPipeline.js's runOrderDeliveredCheck).
  if (isFeedbackRatingExpired(session)) {
    updateSession(chatId, { awaitingFeedbackRating: false, feedbackRequestedAt: null, feedbackOrderRowNumber: null });
  }

  if (session.awaitingFeedbackRating) {
    const parsed = feedbackRatingDetector.parseFeedbackRating(trimmedText);
    if (parsed) {
      const rowNumber = session.feedbackOrderRowNumber;
      // Re-read the row's current customer name fresh from the Sheet rather
      // than trusting anything cached on the session — the row is the
      // source of truth for who this feedback belongs to.
      const order = await googleSheets.getConfirmedOrderByRow(rowNumber).catch(() => null);
      await googleSheets.appendFeedback({
        customerName: (order && order.customerName) || '',
        phone,
        rating: parsed.rating,
        comments: parsed.comment,
      });
      const reply = 'شكراً لتقييمك! 🌸 رأيك بيهمنا جداً وبيساعدنا نتحسن أكتر.';
      const history = (session.llm && session.llm.history) || [];
      const historyAfterModel = pushHistory(pushHistory(history, 'user', trimmedText), 'assistant', reply);
      updateSession(chatId, {
        awaitingFeedbackRating: false,
        feedbackRequestedAt: null,
        feedbackOrderRowNumber: null,
        llm: { history: historyAfterModel },
      });
      return {
        reply,
        logEntry: {
          ...baseLogFields(getSession(chatId), phone, trimmedText),
          notes: `العميل قيّم الأوردر (Confirmed_Orders row ${rowNumber}): ${parsed.rating}/5`,
        },
      };
    }
    // No recognizable digit — fall through to the normal LLM flow below,
    // same "ambiguous, give it another turn" behavior as above.
  }

  // Deterministic, free, no API call — same reasoning as escalation/delivery-
  // feedback above: "where's my order" must answer from the live Sheet
  // status, never from whatever the LLM guesses or half-remembers from
  // conversation history. Runs before any AI tier so it never costs a token.
  if (orderStatusDetector.isOrderStatusInquiry(trimmedText)) {
    return handleOrderStatusInquiry({ chatId, phone, trimmedText, session, history: (session.llm && session.llm.history) || [] });
  }

  // Deterministic, free, no API call — see handleOrderCancellationRequest
  // above. Only armed once a real confirmed order exists to cancel; before
  // that, these same words (or the broader ORDER_CANCEL_KEYWORDS) fall
  // through to the LLM exactly as before — e.g. declining a first
  // recommendation is not "cancel my order".
  if (session.orderPlaced && containsAny(trimmedText, ORDER_CANCELLATION_REQUEST_KEYWORDS)) {
    return handleOrderCancellationRequest({ chatId, phone, trimmedText, session });
  }

  // Deterministic, free, no API call — see handleProductImageRequest above
  // for why this is never left to the LLM to decide/trigger.
  if (productImageRequestDetector.isProductImageRequest(trimmedText)) {
    return handleProductImageRequest({ chatId, phone, trimmedText, session, idMentionProduct });
  }

  // Rolling-window query (see buildSearchQuery above) — not bare trimmedText
  // — so a terse final-step answer in the consultation still carries the
  // skin-type/problem context from the turns just before it. Uses modelText
  // (not trimmedText) so a photo's Vision description can actually surface
  // better-matched candidates (e.g. a dry-skin photo should favor
  // moisturizers even if the caption itself said nothing about skin type).
  const searchQuery = buildSearchQuery(session, modelText);
  const candidates = await selectCandidatesForTurn(searchQuery, {
    excludeIds: session.shownProductIds || [],
    recommendedProduct: session.recommendedProduct,
    campaignOfferProduct: session.campaignOfferProduct,
    idMentionProduct,
  });
  // Routine-bundle upsell: only offered off the top (best-matched) candidate,
  // and only if it isn't already one of the two products in the bundle pair
  // itself (skip offering a moisturizer as its own bundle complement, or
  // re-offering the same pairing turn after turn once both are already shown).
  const bundleComplement = candidates[0] ? routineBundles.getBundleComplement(candidates[0].id) : null;
  const validBundleComplement =
    bundleComplement && !(session.shownProductIds || []).includes(bundleComplement.id) ? bundleComplement : null;
  const customerProfile = buildCustomerProfile(phone, previousUpdatedAt);
  const websiteOrderForPrompt = session.websiteOrder
    ? { ...session.websiteOrder, itemsSummary: websiteOrderDetector.summarizeItems(session.websiteOrder.items) }
    : null;
  // Only rendered for the one turn right after ad-landing detection (see the
  // top of this function) — session.adLandingPending is cleared right after
  // this reply is generated, below, so a later ordinary message in the same
  // conversation doesn't keep re-greeting the customer as if they just
  // clicked the ad every single turn.
  const adLandingForPrompt =
    session.adLandingPending && session.recommendedProduct ? { product: session.recommendedProduct } : null;
  // 2026-08-10: tells Sara WHY idMentionProduct (already guaranteed a
  // candidate this turn via selectCandidatesForTurn's sticky handling above)
  // matters right now — the customer named it by its exact catalog ID/SKU,
  // so this is a confirmed selection, not a guess to hedge on with a general
  // consultation. See llmSystemPrompt.js's buildIdMentionSection.
  const idMentionForPrompt = idMentionProduct ? { product: idMentionProduct } : null;
  // 2026-08-04 zero-lock safeguard: only becomes true once this session has
  // actually crossed the message-volume ceiling — see
  // MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION. Tells the model to make a
  // genuine contextual judgment call about whether this customer still needs
  // a real human agent right now, rather than assuming the count alone means
  // anything — applyValidatedOutput independently verifies eligibility
  // (inboundMessageCount) before ever trusting the model's resulting claim.
  const longConversationPending = inboundMessageCount > MAX_INBOUND_MESSAGES_BEFORE_LONG_CONVERSATION;
  const systemInstruction = buildSystemPrompt(
    candidates,
    validBundleComplement,
    customerProfile,
    Boolean(session.awaitingOrderConfirmationReply),
    Boolean(session.awaitingFeedbackRating),
    websiteOrderForPrompt,
    campaignKnowledge.getActiveOffers(),
    // Soft repetition-loop nudge — exactly the 2nd identical message in a
    // row, so the model gets one chance to break the loop itself. No longer
    // followed by a forced handover on the 3rd repeat (2026-08-04 zero-lock
    // safeguard) — repeating yourself isn't hard evidence a human is needed.
    consecutiveRepeats === 1,
    adLandingForPrompt,
    longConversationPending,
    // 2026-08-09 nationwide shipping expansion — the address collected in a
    // PRIOR turn (this turn's own newly-extracted address, if any, isn't
    // available until after the AI call that's about to use this prompt).
    // buildSystemPrompt computes the real, deterministic zone/fee from this
    // internally (shippingZones.js) — llmAgent.js never touches the fee
    // itself, same separation used for product price grounding.
    session.orderData && session.orderData.deliveryAddress,
    idMentionForPrompt,
    // 2026-08-19 quantity addition — the quantity captured in a PRIOR turn
    // (same "not yet available for this turn's own new extraction" caveat
    // as deliveryAddress just above), paired with the currently-pinned
    // recommendedProduct so buildQuantitySection can ground a real
    // quantity x unit-price total when relevant. See RESPONSE_SCHEMA's
    // order_data.quantity comment for why this must never be computed by
    // the model itself.
    session.orderData && session.orderData.quantity,
    session.recommendedProduct
  );
  const history = (session.llm && session.llm.history) || [];
  const contents = [...history, { role: 'user', content: modelText }];

  // Tier order when enabled: local -> openai -> gemini. The local fine-tuned
  // model was briefly rolled out to 100% of traffic starting 2026-07-13, but
  // as of 2026-07-18 LOCAL_AGENT_ENABLED=false in the live .env — the bot is
  // currently serving all traffic from openai (primary) -> gemini (fallback)
  // only. The local tier's code path here is intentionally left intact
  // (not dead code) so it can be re-enabled via config without a deploy.
  const useLocal = config.localAgentEnabled;
  const callArgs = { systemInstruction, contents, responseSchema: RESPONSE_SCHEMA };

  const tiers = [];
  if (useLocal) tiers.push({ name: 'local', call: () => localService.generateStructuredReply(callArgs) });
  tiers.push({ name: 'openai', call: () => openaiService.generateStructuredReply(callArgs) });
  if (config.geminiFallbackEnabled) tiers.push({ name: 'gemini', call: () => geminiService.generateStructuredReply(callArgs) });

  // Try every tier in order, and — critically — keep going not just when a
  // tier's API call fails outright, but also when it returns schema-valid
  // JSON that fails content validation (bad product reference, unverified
  // price, empty reply_text). Previously a single tier's content failure went
  // straight to the canned fallback without ever trying the next tier, which
  // is how a customer's order-completing message (e.g. just stating their
  // name) could be silently lost when the first tier to respond produced
  // invalid content.
  let validated = null;
  let providerUsed = null;
  for (const tier of tiers) {
    const raw = await tier.call();
    if (!raw) {
      logger.warn(`${tier.name} unavailable — trying next tier.`);
      continue;
    }
    const candidate = validateModelOutput(sanitizeModelOutput(raw), candidates, validBundleComplement);
    if (candidate) {
      validated = candidate;
      providerUsed = tier.name;
      agentStats.recordTierUsage(tier.name);
      break;
    }
    logger.warn(`${tier.name} returned a reply that failed validation — trying next tier.`);
  }

  // Distill every validated teacher-tier (openai/gemini) reply into a
  // training example for the local model — never for providerUsed==='local'
  // itself, since that's the tier we're trying to improve, not imitate.
  if (validated && providerUsed !== 'local') {
    trainingDataLogger.logTrainingExample({ systemInstruction, contents, output: validated, providerUsed });
  }

  if (!validated) {
    agentStats.recordTierUsage('failed');
    // Both providers failed, or validation rejected the surviving output —
    // the bot must never go silent AND must never silently drop what the
    // customer just said. Previously this returned without touching the
    // session at all, so a customer's phone number or address typed on a
    // failed turn was gone for good — the next successful turn would have no
    // idea it was ever sent. Persist the raw message into history (so the
    // next successful call still has full context and can act on it) and
    // opportunistically recover a phone number via a narrow heuristic when
    // one is clearly missing (see recoverOrderDataOnFailure).
    const historyAfterUser = pushHistory(history, 'user', modelText);
    const recoveredOrderData = recoverOrderDataOnFailure(session, trimmedText);

    // See MAX_CONSECUTIVE_TIER_FAILURES's comment near the top of this file —
    // one failure is retried silently as before; a second consecutive one
    // (with no successful turn in between — reset to 0 below whenever a
    // validated reply goes out) hands off to a human instead of repeating
    // the same generic fallback indefinitely.
    const consecutiveTierFailures = (session.consecutiveTierFailures || 0) + 1;
    const tierFailureLoopDetected = consecutiveTierFailures > MAX_CONSECUTIVE_TIER_FAILURES;

    updateSession(chatId, {
      llm: { history: historyAfterUser },
      orderData: recoveredOrderData,
      consecutiveRepeats,
      consecutiveTierFailures: tierFailureLoopDetected ? 0 : consecutiveTierFailures,
      humanHandover: tierFailureLoopDetected ? true : session.humanHandover,
      // Same "stamped fresh only on a genuinely new handoff" reasoning as the
      // main success path further down — tierFailureLoopDetected is only
      // ever true on the turn the handoff actually fires.
      humanHandoffAt: tierFailureLoopDetected ? Date.now() : session.humanHandoffAt,
    });

    if (tierFailureLoopDetected) {
      const logEntry = {
        ...baseLogFields(getSession(chatId), phone, modelText),
        orderStatus: resolveEarlyStageOrderStatus(recoveredOrderData, session.recommendedProduct),
        notes: 'تم التحويل لفريق بشري بعد فشل كل طبقات الذكاء الاصطناعي في الرد مرتين متتاليتين لنفس العميل',
      };
      const adminNotification =
        `🔁 الوكيل الذكي حوّل المحادثة لفريق بشري (فشلت كل طبقات الذكاء الاصطناعي مرتين على التوالي)\n` +
        `رقم العميل: ${phone}\n` +
        `آخر رسالة: ${trimmedText}`;
      return { reply: REPEATED_FALLBACK_LOOP_REPLY, logEntry, adminNotification };
    }

    const logEntry = {
      ...baseLogFields(getSession(chatId), phone, modelText),
      orderStatus: resolveEarlyStageOrderStatus(recoveredOrderData, session.recommendedProduct),
      notes: 'تعذر توليد رد موثوق من الذكاء الاصطناعي (محلي/OpenAI/Gemini) - تم حفظ الرسالة للمتابعة في المحاولة التالية',
    };
    // Every configured tier (local + openai + gemini, whichever are enabled)
    // failed or got rejected by validation for this turn — worth a human's
    // attention, unlike a single tier falling through to the next one, which
    // is routine and would make this alert too noisy to act on.
    const adminNotification =
      `⚠️ فشلت كل طبقات الذكاء الاصطناعي في الرد (محلي/OpenAI/Gemini)\n` +
      `رقم العميل: ${phone}\n` +
      `آخر رسالة: ${trimmedText}`;
    return { reply: `${MESSAGES.fallback}\n${MESSAGES.noProductDataDisclaimer}`, logEntry, adminNotification };
  }

  const applied = applyValidatedOutput(session, validated, candidates, trimmedText);

  // A downgraded SPECIALIST_REFERRAL/CUSTOMER_REQUEST/LONG_CONVERSATION_UNRESOLVED
  // means validated.reply_text may still be the model's (now-rejected)
  // hand-off line — swap it for the generic continuation before it's saved
  // to history or returned to the customer, so the two are never
  // inconsistent (customer told "you need a specialist"/"talk to a human"
  // while everything else in the system treats it as routine).
  const isFallbackDowngrade =
    applied.specialistReferralDowngraded || applied.customerRequestReplyDowngraded || applied.longConversationDowngraded;
  // Loop guard (2026-08-09) — see REPEATED_FALLBACK_LOOP_REASON's comment
  // above for why a second consecutive downgrade must not just repeat the
  // same sentence again. Counts consecutive turns, resets the moment a turn
  // doesn't downgrade.
  const consecutiveFallbackDowngrades = isFallbackDowngrade ? (session.consecutiveFallbackDowngrades || 0) + 1 : 0;
  const fallbackLoopDetected = consecutiveFallbackDowngrades > MAX_CONSECUTIVE_FALLBACK_DOWNGRADES;

  if (fallbackLoopDetected) {
    // Escalate for real instead of sending the identical redirect again —
    // reuses the existing human-handoff machinery (24h cooldown, admin
    // notification) exactly like a genuine SPECIALIST_REFERRAL/
    // LONG_CONVERSATION_UNRESOLVED handover does.
    validated.reply_text = REPEATED_FALLBACK_LOOP_REPLY;
    applied.humanHandover = true;
    applied.handoverReason = REPEATED_FALLBACK_LOOP_REASON;
    applied.stage = STAGES.CLOSED;
  } else if (isFallbackDowngrade) {
    validated.reply_text = NORMAL_CONSULTATION_FALLBACK;
  }

  // The model thought this turn confirmed the order (its reply_text almost
  // certainly says so) but applyValidatedOutput just blocked it because the
  // product went out of stock — never let the "confirmed" claim reach the
  // customer when nothing was actually confirmed.
  if (applied.outOfStockAtConfirmation) {
    validated.reply_text = MESSAGES.outOfStockAtConfirmation;
  }

  // Deterministic backstop — see claimsOrderConfirmationInReply's comment
  // above. Only fires when the order genuinely wasn't confirmed by CODE
  // (orderConfirmed false) and isn't already covered by the out-of-stock
  // branch just above (which has its own, more specific honest message) —
  // replaces the false "it's done" claim with a real confirmation question
  // instead, built from the exact same fields already collected this turn,
  // so the customer gets an honest, actionable next step (a genuine yes/no)
  // rather than believing an order exists that the system never recorded.
  if (!applied.orderConfirmed && !applied.outOfStockAtConfirmation && claimsOrderConfirmationInReply(validated.reply_text)) {
    logger.warn(
      `LLM claimed an order confirmation in reply_text but orderConfirmed was false — overriding with a real confirmation question (was: "${truncate(validated.reply_text, 200)}").`
    );
    validated.reply_text = orderConfirmationSummary({
      productName: applied.recommendedProduct ? applied.recommendedProduct.name : null,
      customerName: applied.orderData.customerName,
      deliveryAddress: applied.orderData.deliveryAddress,
      shippingZone: matchShippingZone(applied.orderData.deliveryAddress),
      shippingMethod: applied.orderData.shippingMethod,
    });
  }

  // Deterministic backstop — see PHOTO_HALLUCINATION_SAFE_REPLY's comment
  // above. Checked after every other reply_text substitution above so it
  // catches a hallucinated photo claim regardless of which branch produced
  // it, and last so it always has the final say over what reaches the
  // customer.
  if (isPhotoAvailabilityHallucination(validated.reply_text)) {
    logger.warn(
      `LLM claimed photo (un)availability on its own — overriding with a safe reply (was: "${truncate(validated.reply_text, 200)}").`
    );
    validated.reply_text = PHOTO_HALLUCINATION_SAFE_REPLY;
  }

  // 2026-08-09 addition — confirmed live (chatId 33561512034419@lid): a real
  // customer tried to cancel a CONFIRMED order 8 separate times in natural
  // colloquial phrasing that ORDER_CANCELLATION_REQUEST_KEYWORDS didn't cover
  // (see prompts.js's 2026-08-09 additions — Egyptian colloquial contractions
  // like "م" for "مش" and "هلغي" for "الغي" can never be fully enumerated).
  // Every attempt fell through to general consultation, which had no real way
  // to help and repeated the exact same "contact customer service" sentence
  // 4 times verbatim, with no phone number and no actual escalation ever
  // firing. This is the general safety net keyword lists can't be: whenever a
  // customer has a CONFIRMED order (the highest-stakes state — an unresolved
  // complaint here risks an unwanted delivery, a refund dispute, a bad
  // review) and Sara's reply this turn is byte-identical to her own
  // immediately preceding reply, that repetition alone is proof the
  // conversation isn't moving forward — escalate for real instead of sending
  // the same non-answer again. Reuses REPEATED_FALLBACK_LOOP's exact reply/
  // reason (same underlying problem: a redirect that isn't working), just
  // triggered by raw reply repetition rather than a specific classified
  // downgrade reason, and fires on the very first detected repeat (not a
  // second one) given the higher stakes of an already-confirmed order.
  const lastAssistantReply = [...history].reverse().find((turn) => turn.role === 'assistant');
  const isRepeatedPostOrderReply = Boolean(
    session.orderPlaced && lastAssistantReply && lastAssistantReply.content === validated.reply_text
  );
  if (isRepeatedPostOrderReply && !fallbackLoopDetected) {
    validated.reply_text = REPEATED_FALLBACK_LOOP_REPLY;
    applied.humanHandover = true;
    applied.handoverReason = REPEATED_FALLBACK_LOOP_REASON;
    applied.stage = STAGES.CLOSED;
  }

  const historyAfterUser = pushHistory(history, 'user', modelText);
  const historyAfterModel = pushHistory(historyAfterUser, 'assistant', validated.reply_text);

  updateSession(chatId, {
    stage: applied.stage,
    orderData: applied.orderData,
    noProgressTurns: applied.noProgressTurns,
    humanHandover: applied.humanHandover,
    // Stamped fresh whenever a handover is flagged this turn, otherwise left
    // untouched. Safe from re-extending the cooldown on every turn while
    // already muted — the client-level cooldown check (see whatsapp/client.js)
    // stops handleMessage from ever being called again until it expires, so
    // this only ever fires on a genuinely new handoff.
    humanHandoffAt: applied.humanHandover ? Date.now() : session.humanHandoffAt,
    orderPlaced: applied.orderConfirmed || session.orderPlaced,
    confirmedProductIds: applied.confirmedProductIds,
    recommendedProduct: applied.recommendedProduct,
    shownProductIds: applied.shownProductIds,
    customerName: applied.orderData.customerName || session.customerName,
    deliveryAddress: applied.orderData.deliveryAddress || session.deliveryAddress,
    llm: { history: historyAfterModel },
    // Persists the repetition count computed near the top of this function
    // (0 if this turn's message didn't repeat the last one) so next turn's
    // comparison has the right running count (drives only the soft prompt
    // nudge now, never a forced handover — see where it's computed above).
    consecutiveRepeats,
    // Drives the loop guard above — 0 whenever this turn wasn't itself a
    // downgrade (so a single isolated redirect never counts against a later,
    // unrelated one) and also reset to 0 once the loop guard has actually
    // escalated, since the human handoff about to happen resolves it — no
    // need to keep counting toward a second escalation on top of the first.
    consecutiveFallbackDowngrades: fallbackLoopDetected ? 0 : consecutiveFallbackDowngrades,
    // Reaching this point at all means a tier validated this turn, so
    // whatever streak of total-tier-failures preceded it (see
    // MAX_CONSECUTIVE_TIER_FAILURES above) is over — reset it rather than
    // letting it carry into an unrelated later failure.
    consecutiveTierFailures: 0,
    // One-shot: this reply is the proactive ad-landing greeting (if any was
    // pending), so it must not fire again on the customer's next ordinary
    // message. adLandingCampaignId itself is left alone — it's just a
    // "already handled this session" marker, not something later turns read.
    adLandingPending: false,
  });

  const { logEntry, adminNotification, orderHistoryEntry } = buildLogEntryAndNotification(
    getSession(chatId),
    phone,
    modelText,
    validated,
    applied
  );

  return {
    reply: validated.reply_text,
    logEntry,
    adminNotification,
    orderHistoryEntry,
    variantId:
      providerUsed === 'local'
        ? 'llm_local_v1'
        : providerUsed === 'openai'
        ? 'llm_openai_fallback_v1'
        : providerUsed === 'gemini'
        ? 'llm_gemini_fallback_v1'
        : null,
  };
}

module.exports = {
  handleMessage,
  pushHistory,
  // Exposed so scripts/generateSyntheticData.js can reuse the exact same
  // sanitize/validate gate real production traffic goes through, instead of
  // maintaining a second copy that could drift out of sync.
  sanitizeModelOutput,
  validateModelOutput,
  selectCandidatesForTurn,
};
