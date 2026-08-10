// Throwaway regression check (not committed) — item #4 from the 2026-08-08
// diagnostic report ("SPECIALIST_REFERRAL over-triggers on harmless replies
// like تمام or .."). Replays 3 REAL historical cases pulled verbatim from
// chat_history.log where production logs show the LLM asserted
// SPECIALIST_REFERRAL and the code-level guard in llmAgent.js had to
// downgrade it — confirms the just-tightened llmSystemPrompt.js prompt now
// avoids triggering it at the source, against the real OpenAI API (no
// production session/state touched).
const openaiService = require('../src/services/openaiService');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('../src/bot/llmSystemPrompt');

const SPECIALIST_REFERRAL_REPLY_MARKER = 'محتاجة متابعة من فريقنا المتخصص';

const systemPrompt = buildSystemPrompt([], null, null, false, false, null, [], '', null, false);

const cases = [
  {
    name: '".." after an unrelated image-availability question (2026-08-05T20:55, real prod over-trigger)',
    contents: [
      { role: 'user', content: '[صورة]: ديه متاح' },
      { role: 'assistant', content: 'استلمت الصورة، بس للأسف لسه مش قادرة أشوف الصور 🌸\nفريق المتجر هيتأكد من التوفر قريب.' },
      { role: 'user', content: '..' },
    ],
  },
  {
    name: '"نعم" agreeing to continue consultation (2026-07-31T18:13, real prod over-trigger)',
    contents: [
      { role: 'user', content: 'ممكن صورة للمنتجات' },
      { role: 'assistant', content: 'للأسف، مش ممكن أشارك صور للمنتجات هنا. لكن ممكن أساعدك في اختيار المنتجات المناسبة من الكتالوج. لو حابة، أقدر أرشحلك 2-3 منتجات تناسب بشرتك. تحبي نكمل؟' },
      { role: 'user', content: 'نعم' },
    ],
  },
  {
    name: '"تمام" as a bare acknowledgment (2026-08-05T21:02, real prod over-trigger)',
    contents: [{ role: 'user', content: 'تمام' }],
  },
];

const RUNS_PER_CASE = 4;

(async () => {
  let totalFailures = 0;
  let totalRuns = 0;
  for (const c of cases) {
    console.log(`\n--- ${c.name} ---`);
    for (let i = 0; i < RUNS_PER_CASE; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const output = await openaiService.generateStructuredReply({
        systemInstruction: systemPrompt,
        contents: c.contents,
        responseSchema: RESPONSE_SCHEMA,
      });
      // Mirror llmAgent.js's applyValidatedOutput exactly: handover_reason is
      // only ever trusted when human_handover === true (a stray field value
      // alongside human_handover:false is inert in the real pipeline — the
      // customer never sees it and no downgrade log fires for it).
      const claimedReason = output && output.human_handover === true ? output.handover_reason || null : null;
      const trustedHandoverReason = claimedReason === 'SPECIALIST_REFERRAL' ? claimedReason : null;
      const assertsReferral =
        output &&
        (trustedHandoverReason === 'SPECIALIST_REFERRAL' ||
          (typeof output.reply_text === 'string' && output.reply_text.includes(SPECIALIST_REFERRAL_REPLY_MARKER)));
      totalRuns += 1;
      if (assertsReferral) totalFailures += 1;
      console.log(
        `  run ${i + 1}: human_handover=${output && output.human_handover}, handover_reason=${output && output.handover_reason} — ${
          assertsReferral ? '❌ ASSERTS SPECIALIST_REFERRAL' : '✅ clean'
        } — reply: "${output && output.reply_text}"`
      );
    }
  }
  console.log(`\n${totalFailures}/${totalRuns} runs still over-trigger (customer-facing, matching real llmAgent.js guard logic).`);
  process.exit(totalFailures > 0 ? 1 : 0);
})();
