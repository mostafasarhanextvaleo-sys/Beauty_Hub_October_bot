const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');
const { normalizeArabic, containsAny } = require('../utils/helpers');
const productMatcher = require('./productMatcher');
const { getAllSessions } = require('./conversationMemory');
const agentStats = require('./agentStats');
const botControl = require('./botControl');
const openaiService = require('../services/openaiService');
const corrections = require('./corrections');

const OLLAMA_PING_TIMEOUT_MS = 3000;

// Exact/near-exact Arabic phrases map to a real action — kept deterministic
// (not LLM-classified) since these trigger side effects (pausing the bot,
// forcing a Sheets refresh); a misclassification here is a lot more costly
// than a misclassified customer chit-chat message. Free-form phrasing
// ("بتعمل ايه", "نسيت الأوامر", ...) is handled separately below, purely as
// a route to the help guide — it never triggers an action itself.
const COMMANDS = [
  {
    match: ['وضع السيرفر'],
    description: 'يوريك حالة السيرفر دلوقتي: الموديل الأساسي، حالة Ollama، ومدة تشغيل البوت.',
    run: handleServerStatus,
  },
  {
    match: ['تحديث الاسعار', 'تحديث الأسعار'],
    description: 'يعمل تحديث فوري لقائمة المنتجات والأسعار من Google Sheet.',
    run: handleReloadProducts,
  },
  {
    match: ['المحادثات النشطه', 'المحادثات النشطة'],
    description: 'يوريك ملخص للمحادثات النشطة النهاردة.',
    run: handleActiveSessions,
  },
  {
    match: ['تقرير التوفير'],
    description: 'يحسبلك نسبة الردود اللي اتعملت مجاناً بالموديل المحلي مقابل اللي اتعملت بـ OpenAI/Gemini المدفوعة.',
    run: handleSavingsReport,
  },
  {
    match: ['تقرير السلة المتروكة'],
    description: 'يوريك عدد تذكيرات السلة المتروكة اللي اتبعتت ونسبة تحويلها لأوردرات مؤكدة.',
    run: handleAbandonedCartReport,
  },
  {
    match: ['التصحيحات المعلقة'],
    description: 'يوريك التصحيحات المقترحة من مراجعة المحادثات، مستنية موافقتك. اعتمد وحدة بـ"اعتماد تصحيح N"، أو أكتر من وحدة بـ"اعتماد 1, 2, 5"، أو كلهم بـ"اعتماد الكل" — وبالمثل "رفض تصحيح N" / "رفض 1, 2, 5" / "رفض الكل".',
    run: handleListPendingCorrections,
  },
  {
    match: ['وقف البوت'],
    description: 'يوقف الردود الأوتوماتيكية مؤقتاً عشان تقدر تتعامل مع العملاء بنفسك.',
    run: () => handleSetPaused(true),
  },
  {
    match: ['تشغيل البوت'],
    description: 'يرجع يشغل الردود الأوتوماتيكية تاني بعد الإيقاف.',
    run: () => handleSetPaused(false),
  },
];

const HELP_TRIGGER_KEYWORDS = [
  'help',
  'commands',
  'نسيت الاوامر',
  'نسيت الأوامر',
  'بتعمل ايه',
  'بتعملي ايه',
  'اوامر',
  'أوامر',
  'مساعدة',
  'ايه الاوامر',
  'ايه الأوامر',
];

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function isOllamaResponsive() {
  try {
    const res = await withTimeout(fetch(`${config.ollamaUrl}/api/version`), OLLAMA_PING_TIMEOUT_MS);
    return res.ok;
  } catch (err) {
    return false;
  }
}

function formatUptime() {
  const totalSeconds = Math.floor(process.uptime());
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} ساعة و ${minutes} دقيقة`;
  return `${minutes} دقيقة`;
}

async function handleServerStatus() {
  const ollamaUp = await isOllamaResponsive();
  const stats = agentStats.getStats();
  const primaryModel = config.localModels[0] || 'غير محدد';
  const fallbackChain = [...config.localModels.slice(1), 'openai', config.geminiFallbackEnabled ? 'gemini' : null]
    .filter(Boolean)
    .join(' ← ');

  return (
    `📊 حالة السيرفر:\n` +
    `الموديل الأساسي: ${primaryModel}\n` +
    `سلسلة الاحتياط: ${fallbackChain}\n` +
    `Ollama: ${ollamaUp ? '✅ شغال ورد بسرعة' : '❌ مش رد — راجع السيرفر'}\n` +
    `مدة تشغيل البوت: ${formatUptime()}\n` +
    `المنتجات المحمّلة: ${productMatcher.getProductCount()} (المصدر: ${productMatcher.getSource()})\n` +
    `حالة الردود التلقائية: ${botControl.isPaused() ? '⏸️ متوقفة' : '▶️ شغالة'}\n` +
    `عدد الردود من بداية التشغيل: محلي ${stats.local} | OpenAI ${stats.openai} | Gemini ${stats.gemini} | فشل ${stats.failed}`
  );
}

async function handleReloadProducts() {
  const refreshed = await productMatcher.refreshFromGoogleSheets();
  if (refreshed) {
    return `✅ تم تحديث الأسعار والمنتجات. عدد المنتجات دلوقتي: ${productMatcher.getProductCount()} (المصدر: ${productMatcher.getSource()}).`;
  }
  return `❌ فشل تحديث الأسعار من Google Sheet — البوت لسه شغال بآخر بيانات معروفة (${productMatcher.getProductCount()} منتج).`;
}

function startOfTodayMs() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

async function handleActiveSessions() {
  const todayStart = startOfTodayMs();
  const active = getAllSessions()
    .filter(([, session]) => (session.updatedAt || 0) >= todayStart)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));

  if (active.length === 0) {
    return '📭 مفيش محادثات نشطة النهاردة لحد دلوقتي.';
  }

  const MAX_LISTED = 10;
  const lines = active.slice(0, MAX_LISTED).map(([chatId, session]) => {
    const phone = chatId.split('@')[0];
    const name = session.customerName ? ` (${session.customerName})` : '';
    // numberingSystem: 'latn' forces Western digits — ar-EG defaults to
    // Arabic-Indic numerals, inconsistent with plain digits used everywhere
    // else in this bot (prices, dates, phone numbers).
    const time = new Date(session.updatedAt).toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
    return `- ${phone}${name} — ${session.stage} — آخر نشاط ${time}`;
  });

  const extra = active.length > MAX_LISTED ? `\n...و ${active.length - MAX_LISTED} محادثة تانية.` : '';
  return `💬 محادثات نشطة النهاردة: ${active.length}\n${lines.join('\n')}${extra}`;
}

// Computed straight from session state (nudgeSentAt/secondNudgeSentAt/
// orderPlaced — all already persisted by cartRecovery.js/llmAgent.js), not a
// separate stats file — cartRecovery.js never sends a nudge to a session
// that already has orderPlaced=true, so "nudged AND orderPlaced" always
// means the order closed AFTER the nudge, never before it. That's what
// makes this a real recovery-rate number rather than a guess.
async function handleAbandonedCartReport() {
  const sessions = getAllSessions().map(([, session]) => session);
  const firstNudged = sessions.filter((s) => s.nudgeSentAt);

  if (firstNudged.length === 0) {
    return '📭 لسه مفيش تذكيرات سلة متروكة اتبعتت.';
  }

  const recoveredAfterFirstOnly = firstNudged.filter((s) => s.orderPlaced && !s.secondNudgeSentAt);
  const secondNudged = firstNudged.filter((s) => s.secondNudgeSentAt);
  const recoveredAfterSecond = secondNudged.filter((s) => s.orderPlaced);
  const totalRecovered = recoveredAfterFirstOnly.length + recoveredAfterSecond.length;
  const recoveryPct = Math.round((totalRecovered / firstNudged.length) * 100);
  const stillWaiting = firstNudged.length - totalRecovered;

  return (
    `🛒 تقرير السلة المتروكة:\n` +
    `إجمالي العملاء اللي اتبعتلهم تذكير: ${firstNudged.length}\n` +
    `اتحولوا لأوردر مؤكد: ${totalRecovered} (${recoveryPct}%)\n` +
    `  - اتحول من التذكير الأول بس: ${recoveredAfterFirstOnly.length}\n` +
    `  - اتبعتلهم تذكير تاني (فيه توصيل مجاني): ${secondNudged.length}، واتحول منهم: ${recoveredAfterSecond.length}\n` +
    `لسه مستنيين رد: ${stillWaiting}`
  );
}

// chatId truncated for readability, and marked when it came from the
// synthetic TEST_CUSTOMER runner rather than a real conversation — matters
// for judging whether a proposed correction is a genuine customer-facing
// issue or an artifact of a scripted test scenario.
async function handleListPendingCorrections() {
  const pending = corrections.getPendingCorrections();
  if (pending.length === 0) {
    return '📭 مفيش تصحيحات مستنية المراجعة دلوقتي.';
  }

  const lines = pending.map((p) => {
    const source = p.isTestCustomer ? 'TEST_CUSTOMER' : (p.chatId || '').split('@')[0];
    return `#${p.id} [${source}]\nالقاعدة المقترحة: ${p.rule}\nالسبب: ${p.reason || 'غير محدد'}`;
  });

  return (
    `📝 تصحيحات مستنية المراجعة (${pending.length}):\n\n${lines.join('\n\n')}\n\n` +
    `اعتمدي وحدة بـ"اعتماد تصحيح N"، أو أكتر من وحدة بـ"اعتماد 1, 2, 5"، أو كلهم بـ"اعتماد الكل" — وبالمثل مع الرفض (N = رقم #).`
  );
}

async function handleApproveCorrection(id) {
  const approved = corrections.approveCorrection(id);
  if (!approved) return `❌ مفيش تصحيح مستني برقم #${id}.`;
  return `✅ تم اعتماد التصحيح #${id} — البوت هيلتزم بيه من الرسالة الجاية:\n"${approved.rule}"`;
}

async function handleRejectCorrection(id) {
  const rejected = corrections.rejectCorrection(id);
  if (!rejected) return `❌ مفيش تصحيح مستني برقم #${id}.`;
  return `🗑️ تم رفض التصحيح #${id}.`;
}

async function handleApproveAllCorrections() {
  const { approved } = corrections.approveCorrections(null);
  if (approved.length === 0) return '📭 مفيش تصحيحات مستنية عشان تتعمد.';
  const ids = approved.map((a) => `#${a.id}`).join('، ');
  return `✅ تم اعتماد كل التصحيحات المستنية (${approved.length}): ${ids} — البوت هيلتزم بيها من الرسالة الجاية.`;
}

async function handleRejectAllCorrections() {
  const { rejected } = corrections.rejectCorrections(null);
  if (rejected.length === 0) return '📭 مفيش تصحيحات مستنية عشان تترفض.';
  const ids = rejected.map((r) => `#${r.id}`).join('، ');
  return `🗑️ تم رفض كل التصحيحات المستنية (${rejected.length}): ${ids}.`;
}

async function handleApproveBulkCorrections(ids) {
  const { approved, notFound } = corrections.approveCorrections(ids);
  const lines = [];
  if (approved.length > 0) {
    lines.push(`✅ تم اعتماد ${approved.length} تصحيح: ${approved.map((a) => `#${a.id}`).join('، ')}`);
  }
  if (notFound.length > 0) {
    lines.push(`❌ مفيش تصحيحات مستنية بالأرقام دي: ${notFound.map((id) => `#${id}`).join('، ')}`);
  }
  return lines.join('\n');
}

async function handleRejectBulkCorrections(ids) {
  const { rejected, notFound } = corrections.rejectCorrections(ids);
  const lines = [];
  if (rejected.length > 0) {
    lines.push(`🗑️ تم رفض ${rejected.length} تصحيح: ${rejected.map((r) => `#${r.id}`).join('، ')}`);
  }
  if (notFound.length > 0) {
    lines.push(`❌ مفيش تصحيحات مستنية بالأرقام دي: ${notFound.map((id) => `#${id}`).join('، ')}`);
  }
  return lines.join('\n');
}

async function handleSavingsReport() {
  const stats = agentStats.getStats();
  const total = stats.local + stats.openai + stats.gemini;
  if (total === 0) {
    return '📈 لسه مفيش ردود اتعملت من بداية التشغيل عشان أحسب تقرير التوفير.';
  }
  const localPct = Math.round((stats.local / total) * 100);
  const paidPct = 100 - localPct;
  const since = new Date(stats.since).toLocaleDateString('ar-EG');

  return (
    `💰 تقرير التوفير (من ${since}):\n` +
    `الردود اللي اتعملت مجاناً بالموديل المحلي: ${stats.local} (${localPct}%)\n` +
    `الردود اللي اتعملت بموديلات مدفوعة (OpenAI/Gemini): ${stats.openai + stats.gemini} (${paidPct}%)\n` +
    `  - OpenAI: ${stats.openai}\n` +
    `  - Gemini: ${stats.gemini}\n` +
    `إجمالي الردود: ${total}${stats.failed > 0 ? `\n(فشلت كل الطبقات في ${stats.failed} رسالة)` : ''}`
  );
}

async function handleSetPaused(paused) {
  botControl.setPaused(paused);
  return paused
    ? '⏸️ تم إيقاف الردود التلقائية مؤقتاً. ابعتلي "تشغيل البوت" لما تخلص تتعامل مع العملاء بنفسك.'
    : '▶️ تم تشغيل الردود التلقائية تاني. البوت هيرد على العملاء عادي دلوقتي.';
}

function buildStaticHelpText() {
  const lines = COMMANDS.map((c) => `- "${c.match[c.match.length - 1]}": ${c.description}`);
  return (
    `أهلاً! أنا بساعدك تتحكم في البوت. الأوامر المتاحة:\n\n${lines.join('\n')}\n\n` +
    `ابعت أي أمر من دول زي ما هو مكتوب وهعمله فوراً.`
  );
}

async function generateDynamicHelpText() {
  const commandList = COMMANDS.map((c) => `- "${c.match[c.match.length - 1]}": ${c.description}`).join('\n');
  const systemPrompt =
    `أنت مساعد تقني بترد على صاحب متجر "Beauty Hub October" (مش عميل) لما يسأل عن الأوامر الإدارية المتاحة للبوت.\n` +
    `اشرحله بالظبط الأوامر دي، من غير ما تخترع أي أمر جديد مش موجود في القائمة، واذكر كل أمر بين علامتي تنصيص بالظبط زي ما هو مكتوب:\n\n${commandList}`;

  try {
    const reply = await openaiService.generateReply(systemPrompt, 'اشرحلي الأوامر المتاحة');
    return reply || buildStaticHelpText();
  } catch (err) {
    logger.error('Failed to generate dynamic admin help text — using static guide.', err);
    return buildStaticHelpText();
  }
}

function isHelpRequest(normalizedText) {
  return containsAny(normalizedText, HELP_TRIGGER_KEYWORDS);
}

// Parameterized, unlike the fixed COMMANDS list — "اعتماد تصحيح 3" /
// "رفض تصحيح 3" carry a correction id, so these need a pattern match rather
// than an exact-string lookup.
function matchCorrectionReviewCommand(normalizedText) {
  const approveMatch = normalizedText.match(/^اعتماد\s*تصحيح\s*#?\s*(\d+)$/);
  if (approveMatch) return { action: 'approve', id: parseInt(approveMatch[1], 10) };
  const rejectMatch = normalizedText.match(/^رفض\s*تصحيح\s*#?\s*(\d+)$/);
  if (rejectMatch) return { action: 'reject', id: parseInt(rejectMatch[1], 10) };
  return null;
}

// "اعتماد الكل" / "رفض الكل" — approve/reject every pending correction at once.
function matchBulkAllCorrectionsCommand(normalizedText) {
  if (normalizedText === 'اعتماد الكل') return { action: 'approve' };
  if (normalizedText === 'رفض الكل') return { action: 'reject' };
  return null;
}

// Splits a run of ids on any mix of spaces, ASCII commas, or Arabic commas
// ("1, 2, 5" / "1 2 5" / "1،2،5" all work), dedupes, and drops anything that
// isn't a whole number.
function parseIdList(str) {
  const ids = str
    .split(/[\s,،]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
  return [...new Set(ids)];
}

// "اعتماد 1, 2, 5" / "رفض 1 2 5" — bulk approve/reject of specific ids.
// Anchored to digits/separators only, so it never collides with the
// "اعتماد تصحيح N" single-id command (which has "تصحيح" in between).
function matchBulkIdsCorrectionsCommand(normalizedText) {
  const approveMatch = normalizedText.match(/^اعتماد\s+([\d\s,،]+)$/);
  if (approveMatch) {
    const ids = parseIdList(approveMatch[1]);
    if (ids.length > 0) return { action: 'approve', ids };
  }
  const rejectMatch = normalizedText.match(/^رفض\s+([\d\s,،]+)$/);
  if (rejectMatch) {
    const ids = parseIdList(rejectMatch[1]);
    if (ids.length > 0) return { action: 'reject', ids };
  }
  return null;
}

// Returns a reply string — never null, so the admin channel is never
// silent. Every branch here is a real action (deterministic match) except
// the help guide, which is generated dynamically but grounded in the exact
// COMMANDS list above so it can't describe a command that doesn't exist.
async function handleAdminMessage(text) {
  const normalized = normalizeArabic(text);

  const reviewCommand = matchCorrectionReviewCommand(normalized);
  if (reviewCommand) {
    return reviewCommand.action === 'approve'
      ? handleApproveCorrection(reviewCommand.id)
      : handleRejectCorrection(reviewCommand.id);
  }

  const bulkAllCommand = matchBulkAllCorrectionsCommand(normalized);
  if (bulkAllCommand) {
    return bulkAllCommand.action === 'approve' ? handleApproveAllCorrections() : handleRejectAllCorrections();
  }

  const bulkIdsCommand = matchBulkIdsCorrectionsCommand(normalized);
  if (bulkIdsCommand) {
    return bulkIdsCommand.action === 'approve'
      ? handleApproveBulkCorrections(bulkIdsCommand.ids)
      : handleRejectBulkCorrections(bulkIdsCommand.ids);
  }

  for (const command of COMMANDS) {
    if (command.match.some((phrase) => normalizeArabic(phrase) === normalized)) {
      return command.run();
    }
  }

  if (isHelpRequest(normalized)) {
    return generateDynamicHelpText();
  }

  // Unrecognized admin input defaults to help rather than silence or a
  // confusing "unknown command" — this channel has exactly one user and
  // should always be useful.
  return generateDynamicHelpText();
}

module.exports = { handleAdminMessage };
