/**
 * Idle Conversation Evaluator — standalone daemon (own pm2 process, does NOT
 * share memory with the main bot process). Periodically scans conversation
 * sessions and grades finished/idle ones for tone, pricing accuracy, upsell
 * attempt, and product relevance, using OpenAI (see ANTHROPIC_API_KEY note
 * in corrections.js / the conversation this was designed in — no Claude key
 * is configured, so this reuses the OpenAI tier already trusted with real
 * customer conversation data elsewhere in the bot).
 *
 * IMPORTANT DESIGN NOTE — why this only READS sessions_state.json:
 * This runs as a separate OS process from the main bot, so it does not share
 * conversationMemory.js's in-memory Map. Two processes independently
 * read-modify-writing the same sessions_state.json would race and could
 * silently drop real conversation updates. So this script only ever READS
 * that file, fresh on every scan, and keeps its OWN separate bookkeeping
 * file (evaluated_chats.json) for "already evaluated" state — the only
 * writer of sessions_state.json remains the main bot process.
 *
 * Findings never go live automatically: a proposed correction is appended to
 * corrections_pending.json and requires an explicit admin approval command
 * ("اعتماد تصحيح N") before corrections.js's approveCorrection() moves it
 * into the live corrections.json that llmSystemPrompt.js injects.
 */

const fs = require('fs');
const path = require('path');
const openaiService = require('../src/services/openaiService');
const corrections = require('../src/bot/corrections');
const { TEST_CUSTOMER_CHAT_ID } = require('../src/bot/testCustomer');

const SESSIONS_PATH = path.join(__dirname, '..', 'sessions_state.json');
const EVALUATED_PATH = path.join(__dirname, '..', 'evaluated_chats.json');
const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute
const TEST_CUSTOMER_IDLE_MS = 2 * 60 * 1000; // 2 minutes, as originally specified
// Real customers routinely pause well over 2 minutes mid-conversation while
// still deciding — evaluating on a short idle timer would mostly grade
// incomplete snapshots and burn API calls doing it. Real chats are evaluated
// either at a genuine end-state (order confirmed / handed to a human) or
// after being truly abandoned for a long window.
const REAL_CHAT_ABANDONED_IDLE_MS = 60 * 60 * 1000; // 1 hour

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return raw;
  } catch (err) {
    console.error(`Failed to read ${filePath}, using fallback.`, err.message);
    return fallback;
  }
}

function loadEvaluatedMap() {
  const raw = loadJson(EVALUATED_PATH, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function saveEvaluatedMap(map) {
  fs.writeFileSync(EVALUATED_PATH, JSON.stringify(map, null, 2));
}

function loadSessions() {
  const raw = loadJson(SESSIONS_PATH, []);
  return Array.isArray(raw) ? raw : [];
}

// history is session.llm.history, in the canonical {role: 'user'|'assistant',
// content} shape (see llmAgent.js's pushHistory) — sessions_state.json has
// been in this format since 2026-07-18; older persisted sessions are migrated
// on load by conversationMemory.js in the main bot process, and this script
// reads that same file.
function transcriptFromHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return '(no conversation turns recorded)';
  return history
    .map((turn) => {
      const speaker = turn.role === 'assistant' ? 'سارة (البوت)' : 'العميل';
      return `${speaker}: ${turn.content || ''}`;
    })
    .join('\n');
}

function isEligibleForEvaluation(chatId, session, now) {
  const isTestCustomer = chatId === TEST_CUSTOMER_CHAT_ID;
  const idleMs = now - (session.updatedAt || 0);

  if (isTestCustomer) {
    return idleMs >= TEST_CUSTOMER_IDLE_MS;
  }

  const reachedEndState = session.orderPlaced === true || session.humanHandover === true;
  const trulyAbandoned = idleMs >= REAL_CHAT_ABANDONED_IDLE_MS;
  return reachedEndState || trulyAbandoned;
}

function buildEvaluatorPrompt() {
  return (
    `أنتِ مراجعة جودة لمحادثات بوت مبيعات كوزمابيتكس اسمه "سارة" في متجر "Beauty Hub October" — بوت بيتبع أسلوب "خبيرة تجميل ناصحة" مش بياعة تقليدية، بيقترح روتين للعناية بالبشرة، وممنوع عليه يخترع منتج أو سعر مش موجود في الكتالوج.\n\n` +
    `هتاخد نص المحادثة كاملة وتقيّمها في 4 جوانب:\n` +
    `1. النبرة (advisor tone, دافئة وشخصية مش رسمية جامدة)\n` +
    `2. دقة الأسعار (السعر المذكور واضح ومتسق، مفيش تناقض)\n` +
    `3. محاولة البيع الإضافي (upsell/routine suggestion) لو كان السياق مناسب لها\n` +
    `4. مدى ملاءمة المنتج المقترح لسؤال العميل\n\n` +
    `رد بصيغة JSON فقط بدون أي نص إضافي، بالشكل ده بالظبط:\n` +
    `{"overall": "good" أو "needs_improvement", "issues": ["مشكلة 1", "مشكلة 2"] (فاضية لو overall هو good), ` +
    `"proposed_correction": "قاعدة تصحيح مختصرة وقابلة للتنفيذ بصيغة أمر للبوت (بالمصرية)، أو null لو overall هو good"}\n\n` +
    `القاعدة المقترحة (proposed_correction) لازم تكون قابلة للتطبيق مباشرة كتعليمة للبوت، زي: ` +
    `"لما العميل يسأل عن سعر الشحن، متقوليش رقم محدد، خليها فريق المتجر يأكد." — مش وصف عام للمشكلة.`
  );
}

async function evaluateConversation(chatId, session) {
  const transcript = transcriptFromHistory(session.llm && session.llm.history);
  const userPrompt = `المحادثة:\n${transcript}\n\nمنتج اترشح (لو موجود): ${session.recommendedProduct ? session.recommendedProduct.name : 'لا يوجد'}`;

  const reply = await openaiService.generateReply(buildEvaluatorPrompt(), userPrompt);
  if (!reply) throw new Error('Evaluator got no reply from OpenAI');

  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch (err) {
    throw new Error(`Evaluator returned non-JSON: ${reply.slice(0, 200)}`);
  }
  return {
    overall: parsed.overall === 'needs_improvement' ? 'needs_improvement' : 'good',
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    proposedCorrection: typeof parsed.proposed_correction === 'string' ? parsed.proposed_correction.trim() : null,
  };
}

async function scan() {
  const sessions = loadSessions(); // [[chatId, session], ...]
  const evaluated = loadEvaluatedMap();
  const now = Date.now();

  for (const [chatId, session] of sessions) {
    if (!session || !session.llm || !Array.isArray(session.llm.history) || session.llm.history.length === 0) continue;
    if (!isEligibleForEvaluation(chatId, session, now)) continue;

    const lastEvaluatedAt = evaluated[chatId] || 0;
    if ((session.updatedAt || 0) <= lastEvaluatedAt) continue; // already graded, nothing new since

    try {
      console.log(`Evaluating ${chatId} (${session.llm.history.length} turn(s))...`);
      const verdict = await evaluateConversation(chatId, session);

      if (verdict.overall === 'good') {
        console.log(`  -> good, no correction needed.`);
      } else {
        const id = corrections.addPendingCorrection({
          rule: verdict.proposedCorrection || verdict.issues.join('; '),
          reason: verdict.issues.join('; '),
          chatId,
          isTestCustomer: chatId === TEST_CUSTOMER_CHAT_ID,
        });
        console.log(`  -> needs_improvement, added pending correction #${id}: "${verdict.proposedCorrection}"`);
      }

      evaluated[chatId] = session.updatedAt || now;
    } catch (err) {
      console.error(`  FAILED to evaluate ${chatId}: ${err.message}`);
      // Don't mark as evaluated — retry next scan.
    }
  }

  saveEvaluatedMap(evaluated);
}

function startScanLoop() {
  console.log(`Chat evaluator started — scanning every ${SCAN_INTERVAL_MS / 1000}s.`);
  // Deliberately NOT unref'd, unlike the equivalent timers in cartRecovery.js/
  // productMatcher.js — this script has nothing else keeping its event loop
  // alive (no Express server, no WhatsApp client), so an unref'd timer let
  // the process exit right after each scan and pm2 kept restarting it in a
  // tight loop (23 restarts in under a minute before this was caught).
  setInterval(() => {
    scan().catch((err) => console.error('Evaluator scan failed.', err));
  }, SCAN_INTERVAL_MS);
  scan().catch((err) => console.error('Evaluator initial scan failed.', err));
}

// Only auto-starts when run directly (`node scripts/chatEvaluator.js`) — a
// bare require() (e.g. from a test) must not have the side effect of
// immediately scanning real session data and calling OpenAI.
if (require.main === module) {
  startScanLoop();
}

module.exports = { isEligibleForEvaluation, transcriptFromHistory, evaluateConversation, scan };
