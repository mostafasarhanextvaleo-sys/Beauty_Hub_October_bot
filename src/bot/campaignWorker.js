const logger = require('../utils/logger');
const config = require('../config');
const googleSheets = require('../services/googleSheets');
const invoiceService = require('./invoiceService');
const { getSession, updateSession } = require('./conversationMemory');
const productMatcher = require('./productMatcher');
const { runExclusive } = require('../utils/chatLock');
const adLeadDetector = require('./adLeadDetector');
const { parsePriceToNumber } = require('../utils/invoiceGenerator');

// 2026-08-12 (store owner directive): campaign TEST_TRIGGER sends used to go
// only to config.adminWhatsappNumber (201098175119). A second, fixed
// recipient the owner wants every test send mirrored to — scoped to this
// one feature only, deliberately not folded into adminWhatsappNumber, which
// is also used for real customer-facing admin alerts (order completions,
// unmatched-product needs, error/health alerts) elsewhere in this codebase
// that the owner never asked to duplicate here.
const CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER = '201156630487';

// 2026-08-12 (store owner directive): these two numbers are the owner's own
// admin/test devices (the same ones above — Main = adminWhatsappNumber,
// Secondary = CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER) and must never be
// affected by any of the mechanisms this file applies to *real customers*:
// the hard Blocked list, Opt-Out tracking, Bot Paused, and the per-contact
// touch cap. Those mechanisms exist to protect real customers' consent and
// this bot's WhatsApp standing — they were never meant to catch the owner's
// own repeated test sends. Scoped to exactly these two numbers, not a
// general "admin bypass", so it can't silently grow to cover a real
// customer's number later.
const PROTECTED_TEST_NUMBERS = new Set([config.adminWhatsappNumber, CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER].filter(Boolean));

// Accepts a raw phone number or a WhatsApp chatId (`<digits>@c.us`/`@lid`)
// and strips everything down to bare digits so it can be compared against
// PROTECTED_TEST_NUMBERS regardless of which form the caller has on hand.
function normalizePhoneDigits(value) {
  return String(value || '').replace(/@.*/, '').replace(/\D/g, '');
}

function isProtectedTestNumber(...values) {
  return values.some((v) => PROTECTED_TEST_NUMBERS.has(normalizePhoneDigits(v)));
}

const SEND_INTERVAL_MS = 6 * 60 * 1000; // per-message spacing once CAMPAIGN_STATUS=PUSH
const TEST_TRIGGER_POLL_MS = 20 * 1000; // separate, fast poll — a single self-send has no ban-risk to pace
// Mirrors llmAgent.js's MAX_HISTORY_TURNS — kept as a separate constant
// rather than importing that one since it's a private, unexported detail of
// llmAgent.js's own turn-pushing helper, not a shared config value.
const CAMPAIGN_HISTORY_CAP = 40;
// 2026-08-02 audit fix: the campaign drained its entire 35-lead queue in one
// continuous run (09:01-14:22, one every ~6min) the moment CAMPAIGN_STATUS
// flipped to PUSH — no cap, no way to pause mid-run short of flipping the
// switch back. Derived from existing sentAt timestamps rather than a new
// counter, so it needs no extra state and survives restarts (which happen
// often on this box) without losing count.
const DAILY_SEND_LIMIT = parseInt(process.env.CAMPAIGN_DAILY_SEND_LIMIT, 10) || 50; // raised from 20, 2026-08-12 store owner directive

function toWhatsAppJid(phoneOrJid) {
  return phoneOrJid.includes('@') ? phoneOrJid : `${phoneOrJid}@c.us`;
}

// 2026-08-02 audit finding: several leads had a human-written objectionReason
// explicitly saying "don't send the standard offer" or "this needs a
// specialist follow-up, not a sales pitch" — and got blasted the exact
// standard sales offer anyway, because nothing ever read that column before
// selecting who's next. These keyword lists are a pragmatic first pass (not
// full NLU) over the free-text notes written during the 2026-07-30 manual
// CRM review and by campaignWorker's own note-writing call sites (see
// handleInboundMessage/SEED_LEADS below) — good enough to catch the
// documented cases, not a guarantee against every possible phrasing.
const SPECIALIST_FOLLOWUP_KEYWORDS = ['متخصص', 'مش عرض بيعي', 'تحويل لفريق', 'دكتور', 'طبيب'];
const AVOID_STANDARD_OFFER_KEYWORDS = ['زاوية مختلفة', 'رسالة مختلفة', 'جرب رسالة'];

function matchesAnyKeyword(text, keywords) {
  return keywords.some((kw) => (text || '').includes(kw));
}

// Central gate for "should this PENDING row ever receive an automated
// campaign send at all" — separate from offer selection/rotation, which only
// runs once a row has already passed this check. Returns { block: false } if
// clear to send, or { block: true, status, reason } naming the
// campaignStatus this row should be reclassified to instead of PENDING.
function classifyLeadForCampaign(row) {
  // Hard-exclude anyone who already has a real completed order — the
  // strongest possible "don't re-pitch them" signal there is, and checked
  // independently of whatever campaignStatus currently says (2026-08-02: a
  // customer manually set to ORDERED status was found re-queued and
  // re-blasted the standard offer months^H^H^H^Hhours later with no code
  // path found that explains it — this makes it self-healing regardless of
  // how a row's status ever ends up back at PENDING again).
  if (row.orderedAt || row.campaignStatus === 'ORDERED') {
    return { block: true, status: 'ORDERED', reason: 'already has a completed real order' };
  }
  if (matchesAnyKeyword(row.objectionReason, SPECIALIST_FOLLOWUP_KEYWORDS)) {
    return { block: true, status: 'NEEDS_HUMAN_REVIEW', reason: 'flagged for specialist/non-sales follow-up, not an automated sales pitch' };
  }
  if (matchesAnyKeyword(row.objectionReason, AVOID_STANDARD_OFFER_KEYWORDS)) {
    return { block: true, status: 'ON_HOLD', reason: 'flagged to avoid the standard offer — needs a different angle before an automated send' };
  }
  return { block: false };
}

// Common WhatsApp Business auto-responder boilerplate — a reply that arrives
// within seconds of a send, in generic English, is almost always the
// recipient's own auto-reply bouncing back rather than a human (confirmed
// 2026-08-02: one lead's "reply" was exactly this, 6 seconds after the send,
// and it silently flipped their status to REPLIED). Deliberately narrow
// (English boilerplate patterns only) — a real Arabic reply, even a short
// one, is never caught by this.
const AUTO_REPLY_PATTERNS = [
  /thank you for (contacting|reaching)/i,
  /we('| a)?ll get back to you/i,
  /this is an automated (message|response|reply)/i,
  /رسالة تلقائية/,
  /سيتم الرد عليكم?/,
];

function looksLikeAutoResponderBoilerplate(text) {
  return AUTO_REPLY_PATTERNS.some((re) => re.test(text || ''));
}

function countSentToday(rows) {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  return rows.filter((r) => (r.sentAt || '').startsWith(todayPrefix)).length;
}

// 2026-08-02 audit fix: offer selection used to be pure round-robin across
// whatever's active, with zero regard for what a lead was actually
// interested in (found sending a foot-scrubber promo to someone whose
// recorded category was a hair-loss treatment). Coarse, keyword-based
// mapping onto the catalog's own 4 categories (skincare/makeup/haircare/
// bodycare — see productMatcher.js's category field) — not real NLU, just
// enough to stop obviously-mismatched sends when a better-fitting active
// offer exists.
const CATEGORY_KEYWORDS = {
  skincare: ['بشرة', 'كريم', 'سيروم', 'حبوب', 'غسول', 'تفتيح', 'صن بلوك', 'مرطب', 'تصبغ', 'نمش', 'حساسية'],
  haircare: ['شعر', 'تساقط', 'شامبو', 'فرد', 'قشرة'],
  bodycare: ['جسم', 'قدم', 'قدمين', 'الجلد الميت', 'صابون', 'تشقق'],
  makeup: ['ميكب', 'ميك اب', 'اساس', 'كونتور', 'أحمر شفاه', 'روج'],
};

function inferLeadCategory(text) {
  const normalized = text || '';
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => normalized.includes(kw))) return category;
  }
  return null; // free text didn't match any known bucket — no basis to prefer one offer over another
}

// Prefers an active offer whose linked catalog product (see Product ID,
// googleSheets.js) shares the lead's inferred interest category; falls back
// to plain round-robin (the original behavior) whenever there's no lead
// category signal, no offer has a resolved product, or none of them match —
// so this can only ever narrow the round-robin pool, never block a send
// outright the way the P0 objection/already-ordered filters do.
function pickOfferForLead(lead, activeOffers) {
  const leadCategory = inferLeadCategory(lead.category);
  const matching = leadCategory ? activeOffers.filter((o) => o.product && o.product.category === leadCategory) : [];
  const pool = matching.length > 0 ? matching : activeOffers;
  const offer = pool[offerRotationIndex % pool.length];
  offerRotationIndex += 1;
  return offer;
}

// Bug found 2026-08-02 (customer 201055189206/Naglaa): campaign sends used to
// go out via a raw client.sendMessage with no trace left in the customer's
// session — so when they replied, the LLM had zero idea an offer had just
// been sent and answered from whatever old, unrelated context was left in
// session.llm.history instead. Recording the offer as an 'assistant' turn
// here, right after it's actually sent, is the fix: the very next inbound
// message reaches llmAgent.js's normal handleMessage flow with the offer
// already in context, same as if Sara had said it herself mid-conversation.
//
// offerProduct (optional, added 2026-08-02): the offer's resolved catalog
// product (see campaignKnowledge.js), stashed on the session as
// campaignOfferProduct. llmAgent.js's selectCandidatesForTurn folds it into
// this contact's candidate list on their next turn(s), the same "sticky"
// mechanism already used for session.recommendedProduct — without this, a
// customer explicitly referencing the offer's product (e.g. "عايزة عرض مبرد
// القدم") could still fail to get a grounded reply if their message's own
// search query doesn't happen to match that product by keyword/semantic
// search, which is exactly the failure this fixes.
function appendOfferToSessionHistory(chatId, offerText, offerProduct) {
  const session = getSession(chatId);
  const history = (session.llm && session.llm.history) || [];
  const nextHistory = [...history, { role: 'assistant', content: offerText }].slice(-CAMPAIGN_HISTORY_CAP);
  const patch = {
    llm: { history: nextHistory },
    // 2026-08-02 audit fix (root cause of the Naglaa/201055189206 lockout): a
    // campaign send is a fresh, deliberate outreach — noProgressTurns left
    // over from an old, unrelated conversation thread must not immediately
    // sabotage it by tripping the human-handoff threshold on the customer's
    // very next reply. Also clears a stale handoff flag for the same reason:
    // this is a fresh, deliberate outreach the owner just triggered, so
    // nothing about THIS fresh message should still be silenced by a
    // leftover flag from something unrelated.
    noProgressTurns: 0,
    humanHandover: false,
    humanHandoffAt: null,
  };
  if (offerProduct) patch.campaignOfferProduct = offerProduct;
  updateSession(chatId, patch);
}

// One-time manual classification from the 2026-07-30 CRM review of all 68
// historical sessions in sessions_state.json. Excludes: 10 B2B/vendor/spam/
// job-seeker contacts (Paymob reps, a group-partnership pitch, a TikTok
// influencer outreach, a job applicant, a follower-growth pitch, a
// procurement-department request, an AI-video-services pitch, an ads-agency
// pitch, a stray Facebook OTP text — including 259944993525773@lid, the
// contact that caused that day's earlier retry-storm incident, which turned
// out to be a Paymob rep, never a real customer); ~22 sessions with zero real
// interest signal (pure ad-click auto-text with no follow-up, or empty); and
// 2 already-converted customers (logged separately, not re-targeted here).
// `category` is recommendedProduct if the session ever reached one, else the
// customer's last real message, else their first — the best available signal
// per contact, not a fabricated label. `note` flags contacts needing
// different handling than the standard offer (see each one below).
const SEED_LEADS = [
  { chatId: '137065945677827@lid', customerName: 'نجلاء', category: 'ليزا صابون طبي بالكبريت – 70 جم', recencyTier: '15-20', note: '' },
  { chatId: '160812383617029@lid', customerName: '', category: 'بيستحمل وقت اطول', recencyTier: '15-20', note: '' },
  { chatId: '76837669629997@lid', customerName: '', category: 'المبرض', recencyTier: '15-20', note: '' },
  { chatId: '151608570716215@lid', customerName: '', category: 'Hello! Can I get more info on this?', recencyTier: '15-20', note: '' },
  { chatId: '84847766827055@lid', customerName: '', category: 'عن المنتج ده حضرتك', recencyTier: '15-20', note: '' },
  { chatId: '120907708264646@lid', customerName: '', category: 'لو سمحت', recencyTier: '15-20', note: '' },
  { chatId: '53047258574869@lid', customerName: 'حنان', category: 'لوشن ترطيب الجسم', recencyTier: '15-20', note: '' },
  { chatId: '107700868366587@lid', customerName: '', category: 'كويسه للطيز', recencyTier: '15-20', note: '' },
  { chatId: '24636318306398@lid', customerName: '', category: 'والشحن', recencyTier: '15-20', note: '' },
  { chatId: '158167086456925@lid', customerName: '', category: 'غسول ديسار بفيتامين سي وحمض الهيالورونيك 100 مل', recencyTier: '15-20', note: '' },
  { chatId: '217690887159934@lid', customerName: '', category: 'مزيل الجلد الميت للقدمين الكهربائي', recencyTier: '15-20', note: '' },
  { chatId: '246162225406075@lid', customerName: '', category: 'لوشن ترطيب الجسم', recencyTier: '15-20', note: '' },
  { chatId: '279538030366767@lid', customerName: '', category: 'صن بلوك ديرماتيك SPF 50', recencyTier: '15-20', note: '' },
  { chatId: '104689911771311@lid', customerName: '', category: 'مزيل الجلد الميت للقدمين الكهربائي', recencyTier: '15-20', note: '' },
  { chatId: '275122736865413@lid', customerName: '', category: 'لا', recencyTier: '8-14', note: 'رفضت العرض السابق ("لا") — جربي زاوية مختلفة مش نفس العرض القياسي' },
  { chatId: '246578535231496@lid', customerName: '', category: 'عندي الوور', recencyTier: '8-14', note: '' },
  { chatId: '244336478437620@lid', customerName: '', category: 'س', recencyTier: '8-14', note: '' },
  { chatId: '152815104200714@lid', customerName: '', category: 'في نمش بس مش كتير', recencyTier: '8-14', note: '' },
  { chatId: '210827227492362@lid', customerName: '', category: 'افضل علاج للحبوب لبشرة دهنية و اثار الحبوب البنية', recencyTier: '8-14', note: '' },
  { chatId: '270424176861279@lid', customerName: '', category: 'ممكن اعرف كريم تفتيح نتيجه سريعه', recencyTier: '8-14', note: '' },
  { chatId: '100760134148250@lid', customerName: '', category: 'السعر وطريقة الاستخدام', recencyTier: '8-14', note: '' },
  { chatId: '228037027184763@lid', customerName: '', category: 'بكام', recencyTier: '8-14', note: '' },
  { chatId: '266090420654116@lid', customerName: '', category: 'اتكلم مع طبيب متخصص', recencyTier: '8-14', note: 'اتحولت لفريق متخصص قبل كده — تواصل متابعة مش عرض بيعي' },
  { chatId: '104556767752349@lid', customerName: '', category: 'شكرا ياحبي', recencyTier: '8-14', note: '' },
  { chatId: '155744137674794@lid', customerName: 'محمد جمال الدين', category: 'افينتي داندل كريم معالج تساقط الشعر 100 جرام', recencyTier: '0-7', note: '' },
  { chatId: '35755737018497@lid', customerName: '', category: 'Hello! Can I get more info on this?', recencyTier: '0-7', note: '' },
  { chatId: '18928105463979@lid', customerName: '', category: 'هل العلاج ده موجود ولا لا', recencyTier: '0-7', note: '' },
  { chatId: '165618334609589@lid', customerName: '', category: 'تفاصيل والسعر', recencyTier: '0-7', note: '' },
  { chatId: '213249639342251@lid', customerName: '', category: 'ايه المنتجات المتاحة', recencyTier: '0-7', note: '' },
  { chatId: '154056517537849@lid', customerName: '', category: 'بكام سعر الصن بلوك', recencyTier: '0-7', note: '' },
  { chatId: '37301807759381@lid', customerName: '', category: 'بيعمل الوش اي', recencyTier: '0-7', note: '' },
  { chatId: '33294636867766@lid', customerName: '', category: 'لا والله لسه', recencyTier: '0-7', note: '' },
  { chatId: '84989148406009@lid', customerName: '', category: 'صن بلوك ديرماتيك SPF 50', recencyTier: '0-7', note: 'اتبعتلها 3 تذكيرات قبل كده من غير رد — جربي رسالة مختلفة' },
  { chatId: '48872499974278@lid', customerName: '', category: 'Hello! Can I get more info on this?', recencyTier: '0-7', note: '' },
];

let seeded = false;
let sendIntervalTimer = null;
let testTriggerTimer = null;
let pausedContactsRefreshTimer = null;
// In-memory dedup guard for captureInboundLead — see its own comment for why
// this needs to be synchronous rather than relying solely on the Sheets
// round-trip.
const capturedChatIds = new Set();

// 2026-08-03 P1 addition — Targeted_Clients!"Bot Paused (this contact)" and
// "Blocked": both need a synchronous, cheap per-message check from
// whatsapp/client.js (same reasoning as botControl.js's own isPaused()) — a
// live Sheets read on every single message would add real latency to every
// reply, which is exactly what earlier fixes in this file have gone out of
// their way to avoid. Instead both share one periodically-refreshed in-memory
// cache (one Sheets read serves both flags), same pattern as
// productMatcher.js/campaignKnowledge.js, just on a much faster cadence (30s,
// not 5min) since these are manual controls an owner expects to take effect
// almost immediately, not eventually.
const CONTACT_FLAGS_REFRESH_MS = 30 * 1000;
let pausedChatIds = new Set();
let blockedChatIds = new Set();
// The two protected numbers' real chatIds are usually opaque WhatsApp "LID"
// ids (privacy-mode contacts) whose digits don't contain the actual phone
// number — isProtectedTestNumber(chatId) alone can't recognize those. Same
// fix as blockedChatIds/pausedChatIds above: cross-reference each
// Targeted_Clients row's own phoneNumber column (which IS the resolved real
// phone) to build a lookup keyed by the row's actual chatId.
let protectedChatIds = new Set();

async function refreshContactFlags() {
  const rows = await googleSheets.getTargetedClientsRows();
  // Protected numbers are excluded here even if the Sheet itself has them
  // marked Paused/Blocked (e.g. a stale row from before this protection
  // existed) — see isProtectedTestNumber's header comment.
  pausedChatIds = new Set(
    rows.filter((r) => r.botPaused && !isProtectedTestNumber(r.chatId, r.phoneNumber)).map((r) => r.chatId)
  );
  blockedChatIds = new Set(
    rows.filter((r) => r.blocked && !isProtectedTestNumber(r.chatId, r.phoneNumber)).map((r) => r.chatId)
  );
  protectedChatIds = new Set(
    rows.filter((r) => isProtectedTestNumber(r.chatId, r.phoneNumber)).map((r) => r.chatId)
  );
}

// 2026-08-12 (store owner directive): exempts the two protected numbers from
// the human-handoff cooldown (conversationMemory.js) and its related
// session.humanHandover flag (cartRecovery.js) — the same "owner's own
// admin/test device, not a real customer" reasoning as Blocked/Opt-Out/
// Bot-Paused above, just for a different mechanism. Checked at each call
// site (whatsapp/client.js, cartRecovery.js, orderPipeline.js) rather than
// inside conversationMemory.js itself, to avoid a circular require
// (conversationMemory.js has no existing dependency on campaignWorker.js).
function isProtectedContact(chatId) {
  if (isProtectedTestNumber(chatId)) return true;
  return protectedChatIds.has(chatId);
}

function isBotPausedForContact(chatId) {
  if (isProtectedTestNumber(chatId)) return false;
  return pausedChatIds.has(chatId);
}

function isContactBlocked(chatId) {
  if (isProtectedTestNumber(chatId)) return false;
  return blockedChatIds.has(chatId);
}

function startPausedContactsAutoRefresh(intervalMs = CONTACT_FLAGS_REFRESH_MS) {
  refreshContactFlags().catch((err) => logger.error('Initial Bot Paused/Blocked contacts refresh failed — no contacts will be treated as paused or blocked until this succeeds.', err));
  if (pausedContactsRefreshTimer) clearInterval(pausedContactsRefreshTimer);
  pausedContactsRefreshTimer = setInterval(() => {
    refreshContactFlags().catch((err) => logger.error('Bot Paused/Blocked contacts refresh failed — using the last known lists.', err));
  }, intervalMs);
  if (pausedContactsRefreshTimer.unref) pausedContactsRefreshTimer.unref();
}

// Called once from index.js after the WhatsApp client's 'ready' event
// (needs a live, authenticated session — resolveRealPhoneFn hits the same
// puppeteer/CDP path as everything else in whatsapp/client.js). Idempotent:
// only inserts rows for chatIds not already present, so a restart never
// resets a lead the owner has already moved to PENDING/OFFER_SENT/etc. back
// to ON_HOLD. Every newly-inserted row starts ON_HOLD — nothing sends until
// the owner deliberately changes a row's status AND sets CAMPAIGN_STATUS to
// PUSH in Offers_Campaign.
async function seedTargetedClientsOnce(resolveRealPhoneFn) {
  if (seeded) return;
  seeded = true;
  try {
    const existingRows = await googleSheets.getTargetedClientsRows();
    const existingChatIds = new Set(existingRows.map((r) => r.chatId));
    const toInsert = SEED_LEADS.filter((lead) => !existingChatIds.has(lead.chatId));
    if (toInsert.length === 0) {
      logger.info('Targeted_Clients already seeded — nothing new to insert.');
      return;
    }

    let inserted = 0;
    for (const lead of toInsert) {
      // eslint-disable-next-line no-await-in-loop
      const phoneNumber = await resolveRealPhoneFn(lead.chatId).catch(() => '');
      // Locked per-chatId (2026-08-03) — this runs once at startup/reconnect,
      // but a real customer message for one of these exact seed contacts
      // could in principle land at the same moment; serializing against the
      // same lock every other Targeted_Clients writer uses closes that off.
      // eslint-disable-next-line no-await-in-loop
      await runExclusive(lead.chatId, () =>
        googleSheets.upsertTargetedClient(lead.chatId, {
          phoneNumber,
          customerName: lead.customerName,
          category: lead.category,
          campaignStatus: 'ON_HOLD',
          leadSource: 'مراجعة تاريخ المحادثات 2026-07-30',
          recencyTier: lead.recencyTier,
          touches: 0,
          objectionReason: lead.note,
          optOut: false,
        })
      );
      inserted += 1;
    }
    logger.success(`Targeted_Clients seeded with ${inserted} lead(s), all ON_HOLD.`);
  } catch (err) {
    seeded = false; // allow a retry on the next restart if this failed
    logger.error('Failed to seed Targeted_Clients.', err);
  }
}

// Round-robin cursor across whichever Offers_Campaign rows are currently
// PUSH — advanced on every tick that actually sends, so running several
// offers at once spreads roughly evenly across the PENDING queue instead of
// whichever offer happens to be listed first hogging every send.
let offerRotationIndex = 0;

async function runCampaignTick(sendMessageFn) {
  const now = new Date().toISOString();
  googleSheets.setLastCampaignTickAt(now).catch(() => {});

  const offers = await googleSheets.getOffersCampaignRows();
  const activeOffers = offers
    .filter((o) => o.campaignStatus === 'PUSH' && o.offerText.trim())
    // Resolved up front (not just at send time) so pickOfferForLead has each
    // offer's category available for matching before a lead is even chosen.
    .map((o) => ({ ...o, product: o.productId ? productMatcher.getById(o.productId) : null }));
  if (activeOffers.length === 0) return; // every offer PAUSE (or empty text) — do nothing, by design

  const rows = await googleSheets.getTargetedClientsRows();

  const sentToday = countSentToday(rows);
  if (sentToday >= DAILY_SEND_LIMIT) {
    logger.info(`Campaign daily send limit reached (${sentToday}/${DAILY_SEND_LIMIT}) — pausing automated sends until tomorrow.`);
    return;
  }

  // 2026-08-12 (store owner directive): broadcast mode — every row in
  // Targeted_Clients gets the active campaign exactly once, sequentially in
  // sheet order (top to bottom), regardless of prior order history or past
  // replies/interactions. This deliberately REMOVES the previous
  // already-ordered and objection-keyword exclusions (classifyLeadForCampaign
  // is no longer consulted here — it's kept exported for the one-time audit
  // script that still uses it, see its own header comment). campaignStatus
  // !== 'OFFER_SENT' is now the only "already sent this round" gate — a row
  // is eligible again only if the owner manually resets its status away from
  // OFFER_SENT. Opt-Out/Bot-Paused/Blocked remain hard boundaries (a
  // customer's explicit request to stop, or the owner's own standing
  // decision about that contact) — not something a bulk-send directive
  // overrides — except for the two numbers isProtectedTestNumber covers
  // (the owner's own admin/test devices).
  const next = rows.find(
    (r) =>
      r.campaignStatus !== 'OFFER_SENT' &&
      (isProtectedTestNumber(r.chatId, r.phoneNumber) || (!r.optOut && !r.botPaused && !r.blocked))
  );
  if (!next) return;

  const offer = pickOfferForLead(next, activeOffers);

  try {
    await sendMessageFn(next.chatId, offer.offerText);
    // Locked per-chatId (2026-08-03): appendOfferToSessionHistory replaces
    // the session's whole `llm.history` array, and so does the in-flight
    // reply-handling path in whatsapp/client.js for this same chatId (same
    // lock key) — without this, whichever of the two finishes last wins
    // outright and silently erases the other's turn (verified: both do a
    // read-then-replace of the same key with no merge). Locking here, after
    // the send but before touching any shared state, means a customer who
    // replies to this very offer within the same instant is never at risk of
    // losing either their reply or the offer text itself from history.
    await runExclusive(next.chatId, async () => {
      appendOfferToSessionHistory(next.chatId, offer.offerText, offer.product);
      await googleSheets.upsertTargetedClient(next.chatId, {
        campaignStatus: 'OFFER_SENT',
        touches: next.touches + 1,
        lastMessageDate: now,
        sentAt: now,
        offerSent: offer.offerName || offer.offerId,
      });
    });
    logger.success(`Campaign offer "${offer.offerId}" sent to ${next.chatId} (${next.customerName || next.phoneNumber || 'no name'}).`);
  } catch (err) {
    logger.error(`Campaign offer "${offer.offerId}" failed to send to ${next.chatId}.`, err);
  }
}

// Checked every TEST_TRIGGER_POLL_MS — scans all 5 offer rows since each has
// its own independent TEST_TRIGGER cell now (2026-08-02, replacing the old
// single-panel layout's one TEST_TRIGGER). Handles each row that's set to
// SEND in turn; sequential (not Promise.all) so a burst of admin test-sends
// can't race each other into overlapping WhatsApp sends.
//
// 2026-08-12: now fans out to TWO recipients — config.adminWhatsappNumber
// (the "main" number) and CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER — also
// sequential per offer, same race-avoidance reasoning. TEST_TRIGGER only
// clears (and LAST_TEST_SENT_AT only gets stamped) once EVERY configured
// recipient has confirmed-succeeded; if any one recipient fails, the flag
// stays at SEND so the next poll retries — same "never silently drop a
// failed send" rule the previous single-recipient version already followed,
// just evaluated across the whole recipient list instead of one send. A
// retry in that case may re-send to a recipient who already got it (no
// per-recipient sent-state is tracked, matching how simple this test-only
// feature already was) — an accepted, low-stakes tradeoff for a
// staff-triggered manual test send, not a real customer-facing message.
async function runTestTriggerCheck(sendMessageFn) {
  const offers = await googleSheets.getOffersCampaignRows();
  const triggered = offers.filter((o) => o.testTrigger === 'SEND');
  if (triggered.length === 0) return;

  if (!config.adminWhatsappNumber) {
    logger.warn('TEST_TRIGGER was set to SEND but ADMIN_WHATSAPP_NUMBER is not configured — clearing without sending.');
    // eslint-disable-next-line no-await-in-loop
    for (const offer of triggered) await googleSheets.clearOfferTestTrigger(offer.rowNumber);
    return;
  }

  const recipients = [...new Set([config.adminWhatsappNumber, CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER])];

  for (const offer of triggered) {
    const text = offer.offerText || `(OFFER_TEXT فارغ لـ ${offer.offerId})`;
    const failures = [];
    for (const recipient of recipients) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sendMessageFn(toWhatsAppJid(recipient), text);
        logger.success(`Test campaign offer "${offer.offerId}" sent to ${recipient}.`);
      } catch (err) {
        failures.push(recipient);
        logger.error(`Failed to send test campaign offer "${offer.offerId}" to ${recipient}.`, err);
      }
    }
    if (failures.length > 0) {
      logger.error(
        `Test campaign offer "${offer.offerId}" failed for ${failures.join(', ')} — leaving TEST_TRIGGER=SEND so the next poll retries it.`
      );
      continue; // eslint-disable-line no-continue
    }
    // 2026-08-03 fix (still applies with multiple recipients): only clear
    // TEST_TRIGGER once every send is a confirmed success — a send that
    // failed only because WhatsApp wasn't ready yet (e.g. right after a
    // restart) must never reset the flag to IDLE with nothing actually
    // sent, which would look like success with no retry.
    // eslint-disable-next-line no-await-in-loop
    await googleSheets.setOfferLastTestSentAt(offer.rowNumber, new Date().toISOString());
    // eslint-disable-next-line no-await-in-loop
    await googleSheets.clearOfferTestTrigger(offer.rowNumber);
    logger.success(`Test campaign offer "${offer.offerId}" delivered to all ${recipients.length} recipient(s) (${recipients.join(', ')}).`);
  }
}

// 2026-08-03 P1 addition — Targeted_Clients!Send Now: an ad-hoc "message this
// one contact right now" trigger, polled on the same cadence as
// runTestTriggerCheck above. Unlike that function's TEST_TRIGGER fix, this
// always clears the flag after one attempt regardless of success or failure
// — this is a deliberate one-off admin action, not something that should
// silently keep retrying forever against a row with a permanent problem (an
// invalid chatId, say). If a send fails, re-checking the box is how the
// admin retries it. Sends the campaign's currently-active offer (same
// category-matching selection as the normal tick) rather than requiring a
// separate free-text field — matches the header comment on the Send Now
// column itself.
async function runSendNowCheck(sendMessageFn) {
  const rows = await googleSheets.getTargetedClientsRows();
  const triggered = rows.filter((r) => r.sendNow);
  if (triggered.length === 0) return;

  const offers = await googleSheets.getOffersCampaignRows();
  const activeOffers = offers
    .filter((o) => o.campaignStatus === 'PUSH' && o.offerText.trim())
    .map((o) => ({ ...o, product: o.productId ? productMatcher.getById(o.productId) : null }));

  for (const row of triggered) {
    try {
      const isProtected = isProtectedTestNumber(row.chatId, row.phoneNumber);
      if (row.optOut && !isProtected) {
        // Opt-out is a hard, trust-sensitive boundary — a manual override
        // still must never message someone who explicitly asked to stop.
        logger.warn(`Send Now was set for ${row.chatId}, but they've opted out — not sending.`);
      } else if ((row.botPaused || row.blocked) && !isProtected) {
        // 2026-08-06 fix: same hard-boundary reasoning as optOut above —
        // Blocked/Bot-Paused is the owner's own standing decision about this
        // contact, and a manual per-row trigger shouldn't be able to bypass
        // it any more than opt-out can.
        logger.warn(`Send Now was set for ${row.chatId}, but they're Blocked or Bot Paused — not sending.`);
      } else if (activeOffers.length === 0) {
        logger.warn(`Send Now was set for ${row.chatId}, but no offer is currently PUSH — nothing to send.`);
      } else {
        const offer = pickOfferForLead(row, activeOffers);
        // eslint-disable-next-line no-await-in-loop
        await sendMessageFn(row.chatId, offer.offerText);
        const now = new Date().toISOString();
        // Locked per-chatId (same reasoning as runCampaignTick's send path
        // above) — this writes the same session.llm.history and
        // Targeted_Clients row a concurrent inbound message could also touch.
        // eslint-disable-next-line no-await-in-loop
        await runExclusive(row.chatId, async () => {
          appendOfferToSessionHistory(row.chatId, offer.offerText, offer.product);
          await googleSheets.upsertTargetedClient(row.chatId, {
            campaignStatus: 'OFFER_SENT',
            touches: row.touches + 1,
            lastMessageDate: now,
            sentAt: now,
            offerSent: offer.offerName || offer.offerId,
          });
        });
        logger.success(`Send Now: sent "${offer.offerId}" to ${row.chatId} (manual trigger).`);
      }
    } catch (err) {
      logger.error(`Send Now failed for ${row.chatId}.`, err);
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await runExclusive(row.chatId, () => googleSheets.upsertTargetedClient(row.chatId, { sendNow: false }));
    }
  }
}

function startCampaignWorker(sendMessageFn) {
  if (sendIntervalTimer) clearInterval(sendIntervalTimer);
  if (testTriggerTimer) clearInterval(testTriggerTimer);

  sendIntervalTimer = setInterval(() => {
    runCampaignTick(sendMessageFn).catch((err) => logger.error('Campaign tick failed.', err));
  }, SEND_INTERVAL_MS);
  if (sendIntervalTimer.unref) sendIntervalTimer.unref();

  testTriggerTimer = setInterval(() => {
    runTestTriggerCheck(sendMessageFn).catch((err) => logger.error('Campaign test-trigger check failed.', err));
    // Same cadence as the test-trigger poll above — both are fast, low-volume,
    // admin-triggered one-offs, so sharing a timer avoids adding a third one.
    runSendNowCheck(sendMessageFn).catch((err) => logger.error('Send Now check failed.', err));
  }, TEST_TRIGGER_POLL_MS);
  if (testTriggerTimer.unref) testTriggerTimer.unref();

  logger.info(
    `Campaign worker started (sends every ${SEND_INTERVAL_MS / 60000}min while CAMPAIGN_STATUS=PUSH, test-trigger checked every ${TEST_TRIGGER_POLL_MS / 1000}s). Currently inert until Offers_Campaign is set to PUSH.`
  );
}

// Fire-and-forget from whatsapp/client.js's message handler — must never
// throw into the real message-processing path (see the incident this
// session already fixed once for what an unguarded hot-path failure costs).
async function handleInboundMessage(chatId, text) {
  try {
    // Locked per-chatId (2026-08-03) — see client.js's call site for why this
    // is now called from inside its own message-handling lock rather than
    // before it: that ordering means acquiring the same lock key here never
    // delays the reply itself, while still serializing this row's
    // read-modify-write against runCampaignTick/captureInboundLead/
    // handleOrderConfirmed for the same chatId (verified race: a campaign
    // send's OFFER_SENT write and this function's read could otherwise
    // interleave so a customer's real, immediate reply — including an
    // explicit opt-out — is silently never recorded).
    await runExclusive(chatId, async () => {
      const rows = await googleSheets.getTargetedClientsRows();
      const row = rows.find((r) => r.chatId === chatId);
      if (!row || row.campaignStatus !== 'OFFER_SENT') return;

      const normalized = (text || '').trim();

      // 2026-08-02 audit finding: a lead's own WhatsApp Business auto-responder
      // bounced back 6 seconds after a campaign send and got counted as a real
      // REPLIED — inflating the metric and losing the OFFER_SENT state a
      // genuine later human reply should have landed on. Deliberately just
      // returns (no status change at all) rather than marking anything —
      // leaves the row as OFFER_SENT so the next real reply is still tracked
      // correctly, and doesn't affect the actual message reaching the normal
      // conversation flow (that happens independently of this bookkeeping).
      if (looksLikeAutoResponderBoilerplate(normalized)) {
        logger.info(`Campaign contact ${chatId}'s reply looks like WhatsApp Business auto-responder boilerplate — not counting as a real reply.`);
        return;
      }

      const isOptOut =
        /وقف الرسائل|مش عايز رسايل|الغاء الاشتراك|unsubscribe/i.test(normalized) &&
        !isProtectedTestNumber(chatId, row.phoneNumber);
      if (isOptOut) {
        await googleSheets.upsertTargetedClient(chatId, {
          campaignStatus: 'DECLINED',
          optOut: true,
          objectionReason: 'طلب وقف الرسائل صراحة',
          repliedAt: new Date().toISOString(),
        });
        logger.info(`Campaign contact ${chatId} opted out — marked DECLINED, will never be messaged again.`);
        return;
      }

      await googleSheets.upsertTargetedClient(chatId, {
        campaignStatus: 'REPLIED',
        repliedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    logger.error(`Campaign inbound-reply tracking failed for ${chatId} (their real reply was still processed normally).`, err);
  }
}

// Called from whatsapp/client.js on every real inbound customer message
// (fire-and-forget — see the call site's comment for why this must never be
// awaited or allowed to delay a reply). Auto-captures brand-new contacts
// into Targeted_Clients as PENDING so they're eligible for the next offer
// campaign, closing the gap found 2026-08-02: SEED_LEADS (above) was a
// one-time manual snapshot taken 2026-07-30, and nothing added rows for
// contacts after that — e.g. 201069041004, who first messaged and placed a
// real order on 2026-07-31, was never captured. Only ever inserts; never
// touches an existing row, so a contact already progressed through
// ON_HOLD/PENDING/OFFER_SENT/REPLIED/ORDERED/DECLINED (by the seed list or
// the campaign worker) is never reset back to PENDING by a later message.
async function captureInboundLead(chatId, { phone, senderName, text } = {}) {
  if (capturedChatIds.has(chatId)) return;
  // Set synchronously, before any await, so a fast burst of messages from
  // the same brand-new contact can't race the Sheets round-trip below and
  // both branches see "not present yet" and insert duplicate rows. This
  // in-process guard is orthogonal to the runExclusive lock below (2026-08-03)
  // — this Set stops *this function* from double-inserting; the lock stops
  // *this row* from being clobbered by a concurrent write from a different
  // campaignWorker function for the same chatId.
  capturedChatIds.add(chatId);
  try {
    await runExclusive(chatId, async () => {
      const rows = await googleSheets.getTargetedClientsRows();
      if (rows.some((r) => r.chatId === chatId)) return; // covers restarts: already captured in a prior process

      await googleSheets.upsertTargetedClient(chatId, {
        phoneNumber: phone || '',
        customerName: senderName || '',
        category: (text || '').trim().slice(0, 200),
        campaignStatus: 'PENDING',
        leadSource: 'التقاط تلقائي عند أول تواصل',
      });
      logger.info(`Auto-captured new contact ${chatId} (${phone || 'no phone'}) into Targeted_Clients as PENDING.`);
    });
  } catch (err) {
    capturedChatIds.delete(chatId); // allow a retry on their next message if this failed
    logger.error(`Auto-capture into Targeted_Clients failed for ${chatId} (their message was still processed normally).`, err);
  }
}

// 2026-08-04 addition — called fire-and-forget from whatsapp/client.js for
// every inbound message, alongside captureInboundLead. Cheap on every call
// that isn't a match (adLeadDetector.detectAdCampaign is a plain substring
// check, no API cost) — tags a contact with a specific ad campaign's Lead
// Source/interested-category the moment their very first message is a
// recognized ad click-through, so campaign performance and future targeted
// outreach can be attributed accurately. Deliberately conservative about an
// existing row, same reasoning as captureInboundLead: never resets a lead
// that's already progressed past PENDING/ON_HOLD (an OFFER_SENT/REPLIED/
// ORDERED/DECLINED/NEEDS_HUMAN_REVIEW contact keeps whatever got them
// there) — but a fresh ad click's Lead Source/category is still worth
// recording even on an existing PENDING/ON_HOLD row, since nothing about
// their targeting has been decided yet.
async function tagAdLead(chatId, { phone, senderName, text } = {}) {
  const campaign = adLeadDetector.detectAdCampaign(text);
  if (!campaign) return;

  try {
    await runExclusive(chatId, async () => {
      const rows = await googleSheets.getTargetedClientsRows();
      const existing = rows.find((r) => r.chatId === chatId);
      const product = campaign.productId ? productMatcher.getById(campaign.productId) : null;
      // Falls back to the campaign's own label if the linked product id ever
      // stops resolving (e.g. removed from the catalog) — never blocks the
      // tagging on catalog lookup succeeding.
      const category = product ? product.name : campaign.leadSource;

      if (!existing) {
        await googleSheets.upsertTargetedClient(chatId, {
          phoneNumber: phone || '',
          customerName: senderName || '',
          category,
          campaignStatus: 'PENDING',
          leadSource: campaign.leadSource,
        });
        logger.success(`Ad-lead "${campaign.id}" tagged ${chatId} into Targeted_Clients as PENDING (${campaign.leadSource}).`);
        return;
      }

      if (existing.campaignStatus === 'PENDING' || existing.campaignStatus === 'ON_HOLD') {
        await googleSheets.upsertTargetedClient(chatId, { category, leadSource: campaign.leadSource });
        logger.info(`Ad-lead "${campaign.id}" updated Lead Source/category for existing contact ${chatId} (status unchanged: ${existing.campaignStatus}).`);
      } else {
        logger.info(
          `Ad-lead "${campaign.id}" detected for ${chatId}, but their Targeted_Clients status (${existing.campaignStatus}) is already past PENDING — leaving it untouched.`
        );
      }
    });
  } catch (err) {
    logger.error(`Ad-lead tagging failed for ${chatId} (their message was still processed normally).`, err);
  }
}

// How long an existing Confirmed_Orders row that hasn't reached Confirmation
// Status 'Confirmed' (still 'Hold' — pipeline hasn't sent the confirm-ask
// yet — or 'Pending' — sent, awaiting the customer's reply) counts as the
// SAME still-open draft rather than an unrelated older order. Reuses
// llmAgent.js's own NEW_EPISODE_GAP_MS value (6h) rather than inventing a
// new threshold — this is the same "same conversation episode" boundary
// already established elsewhere in this codebase.
const OPEN_DRAFT_EPISODE_GAP_MS = 6 * 60 * 60 * 1000;

// 2026-08-11 (store owner directive): a customer can add/change an item
// while their order is still an open draft — LLM-level order_data.confirmed
// fires once per distinct product per session (see llmAgent.js's
// isAlreadyConfirmedProduct, added 2026-08-06 to let a genuine repeat
// purchase in one chat go through) — but the Sheet-level Confirmation
// Status only becomes 'Confirmed' after a SEPARATE explicit reply to the
// order-pipeline's confirm-ask (see orderPipeline.js's Hold->Pending->
// Confirmed flow). A second distinct product confirmed inside that window
// used to always create a second Confirmed_Orders row via appendConfirmedOrder,
// splitting one real order episode into two rows the customer never
// intended as separate orders. This finds that still-open row, if any.
async function findOpenDraftOrderRow(phone) {
  if (!phone) return null;
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const now = Date.now();
  const openRows = rows.filter((r) => {
    if (r.phone !== phone) return false;
    if (!['', 'Hold', 'Pending'].includes(r.confirmationStatus)) return false;
    const ts = new Date(r.date).getTime();
    return Number.isFinite(ts) && now - ts >= 0 && now - ts <= OPEN_DRAFT_EPISODE_GAP_MS;
  });
  if (openRows.length === 0) return null;
  // Most recent, if more than one somehow qualifies — shouldn't happen once
  // this merge path is live, but pre-existing historical rows could.
  return openRows.reduce((latest, r) => (r.rowNumber > latest.rowNumber ? r : latest));
}

// Called from whatsapp/client.js right after a real order gets logged to
// Order History — additive only, never affects the real order flow.
//
// 2026-08-19 audit fix: the Confirmed_Orders read-modify-write below (draft
// lookup + merge-or-append + the 'Hold' reopen) used to run with no lock at
// all, while orderPipeline.js's writes to the exact same Confirmation Status
// cell for the exact same row are locked via runExclusive(chatId, ...) (see
// its own 2026-08-12 comments). Since this function is itself called
// fire-and-forget (never awaited) from whatsapp/client.js right after the
// outer per-chatId lock for that message turn has already been released,
// its Sheets calls could freely interleave with orderPipeline.js's locked
// ones on the same chatId. Confirmed live failure shape: a customer adds a
// second item within the same open-draft window while orderPipeline's
// confirm-ask for the first item is still in flight — this function's
// unlocked setConfirmationStatus(row, 'Hold') could land, then get silently
// overwritten by orderPipeline's locked write finishing after it, losing the
// 'Hold' reopen and leaving the merged order never re-confirmed. Wrapping
// this function's entire Confirmed_Orders + Targeted_Clients sequence in the
// SAME runExclusive(chatId, ...) key orderPipeline.js already uses closes
// this — chatLock's lock is a process-global per-key queue (see
// utils/chatLock.js), so any writer using this same chatId, from any file,
// is now correctly serialized against every other one.
async function handleOrderConfirmed(chatId, { customerName, phone, address, products, totalPrice, shippingMethod }) {
  let appended = null;
  let mergedRowNumber = null;
  try {
    await runExclusive(chatId, async () => {
      const openDraft = await findOpenDraftOrderRow(phone);
      // If the "new" product is already literally in the draft's Products
      // text, this isn't a genuine addition (e.g. a stale/replayed
      // confirmation) — fall through to the normal append path instead, whose
      // own (phone, products, totalPrice, 10-min window) dedup guard already
      // handles that case correctly rather than this merge logic guessing.
      if (openDraft && products && !openDraft.products.includes(products)) {
        const mergedProducts = openDraft.products ? `${openDraft.products} + ${products}` : products;
        const mergedTotal = String(parsePriceToNumber(openDraft.totalPrice) + parsePriceToNumber(totalPrice));
        await googleSheets.updateConfirmedOrderItems(openDraft.rowNumber, { products: mergedProducts, totalPrice: mergedTotal });
        mergedRowNumber = openDraft.rowNumber;
        logger.success(
          `Merged an additional item into still-open draft order row ${openDraft.rowNumber} for ${chatId} (now: "${mergedProducts}", ${mergedTotal}) instead of creating a new Confirmed_Orders row.`
        );
        if (openDraft.confirmationStatus === 'Pending') {
          // The customer already got asked to confirm the OLD, incomplete item
          // list — reopen to 'Hold' so orderPipeline.js's next poll sends a
          // fresh confirm-ask reflecting the real, merged order instead of
          // silently leaving them to confirm something that's now out of date.
          await googleSheets.setConfirmationStatus(openDraft.rowNumber, 'Hold');
          // eslint-disable-next-line global-require
          require('./orderPipeline').resetConfirmationAskState(openDraft.rowNumber);
        }
      } else {
        // appendConfirmedOrder is append-only (a brand-new row every call, no
        // read-modify-write on an existing one) — kept inside this same lock
        // anyway now, alongside the Targeted_Clients read-then-upsert below,
        // rather than carving it out, since both belong to one atomic-in-intent
        // "record this confirmed order" sequence for this chatId.
        appended = await googleSheets.appendConfirmedOrder({ customerName, phone, address, products, totalPrice, shippingMethod });
      }

      const rows = await googleSheets.getTargetedClientsRows();
      const row = rows.find((r) => r.chatId === chatId);
      // Unlike the old behavior, don't skip when there's no pre-existing row —
      // a confirmed real order is itself the strongest possible intent signal,
      // so it must never go unlogged just because captureInboundLead somehow
      // missed this contact (e.g. a Sheets hiccup on their first message).
      await googleSheets.upsertTargetedClient(chatId, {
        phoneNumber: phone || (row && row.phoneNumber) || '',
        customerName: customerName || (row && row.customerName) || '',
        category: (row && row.category) || products || '',
        leadSource: (row && row.leadSource) || 'طلب مؤكد تلقائي',
        campaignStatus: 'ORDERED',
        orderedAt: new Date().toISOString(),
      });
    });
    logger.success(`Campaign order confirmed and logged to Confirmed_Orders for ${chatId}.`);

    // Invoice link attachment is a separate, best-effort add-on (see
    // invoiceService.js) — deliberately not awaited into the same try block
    // above, so a failed/slow Sheets write here can never delay or affect
    // the order logging that already succeeded. Targets the merged row when
    // this call merged into an existing draft, so the SAME invoice link now
    // reflects the complete, up-to-date item list and total.
    const targetRowNumber = mergedRowNumber || (appended && appended.rowNumber);
    if (targetRowNumber) {
      invoiceService
        .generateAndAttachInvoice({ rowNumber: targetRowNumber })
        .catch((err) => logger.error(`Invoice link attachment kickoff failed for ${chatId}.`, err));
    }

    // 2026-08-09 order-management pipeline (see orderPipeline.js) — sets the
    // new I:K columns' defaults ('', 'Hold', 'Processing') on this brand-new
    // row only. Same best-effort, non-blocking shape as the invoice kickoff
    // above: a failure here must never retroactively affect the order row
    // itself. orderPipeline.js's own 20s poll picks up the fresh 'Hold' row
    // and sends the confirmation-request message; this function does not
    // send anything itself. Deliberately NOT run for a merged row — it
    // already has real I:K state (possibly already 'Sent'/'Processing')
    // that resetting to these defaults would wrongly wipe out.
    if (appended && appended.rowNumber) {
      googleSheets
        .initializeOrderPipelineColumns(appended.rowNumber)
        .catch((err) => logger.error(`Order-pipeline column init failed for ${chatId} (row ${appended.rowNumber}).`, err));
    }
  } catch (err) {
    logger.error(`Campaign Confirmed_Orders logging failed for ${chatId}.`, err);
  }
}

module.exports = {
  seedTargetedClientsOnce,
  startCampaignWorker,
  handleInboundMessage,
  captureInboundLead,
  tagAdLead,
  handleOrderConfirmed,
  // Exported mainly for isolated testing (see scripts/) — startCampaignWorker
  // is what actually drives these on their real timers in production.
  runCampaignTick,
  runTestTriggerCheck,
  // Reused by src/index.js's POST /admin/send-message — any manually
  // triggered outbound message needs the same "record it in session history"
  // treatment as a campaign send, so a customer's reply is still understood
  // in context.
  appendOfferToSessionHistory,
  // Reused by the 2026-08-02 one-time cleanup pass (reclassifying leads sent
  // before this logic existed) and available for any future audit pass —
  // keeps a single source of truth for the classification rules instead of
  // a script reimplementing the same keyword lists.
  classifyLeadForCampaign,
  // Send Now is exported mainly for isolated testing, same as runCampaignTick
  // above — startCampaignWorker's own timer is what drives it in production.
  runSendNowCheck,
  // Bot Paused (this contact) / Blocked — startPausedContactsAutoRefresh is
  // called once from index.js at startup (doesn't need WhatsApp, only Sheets,
  // so it isn't gated on onReady like the WhatsApp-sending schedulers are);
  // isBotPausedForContact/isContactBlocked are the synchronous per-message
  // checks whatsapp/client.js calls.
  startPausedContactsAutoRefresh,
  isBotPausedForContact,
  isContactBlocked,
  // 2026-08-12 — checked by whatsapp/client.js, cartRecovery.js, and
  // orderPipeline.js alongside the human-handoff cooldown/humanHandover
  // flag, see its own header comment above.
  isProtectedContact,
};
