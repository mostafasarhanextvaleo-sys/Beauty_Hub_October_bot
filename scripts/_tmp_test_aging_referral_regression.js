// Regression check (not committed) for the 2026-08-09 P0 fix: "SPECIALIST_REFERRAL
// over-triggers on anti-aging vocabulary (خطوط/ترهلات/تجاعيد/انتفاخ تحت العين)
// the same way plain 'حبوب' used to before the 2026-07-18 acne hardening."
// Replays the REAL historical case pulled verbatim from chat_history.log
// (chatId 22695194415336@lid, 2026-07-19) where production logs show the
// customer gave a full skin profile + an explicit 500 EGP budget and got the
// same non-advancing NORMAL_CONSULTATION_FALLBACK sentence 3 times in a row —
// against the real OpenAI API (no production session/state touched, mirrors
// scripts/_tmp_test_specialist_referral_regression.js's pattern exactly).
const openaiService = require('../src/services/openaiService');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('../src/bot/llmSystemPrompt');

const SPECIALIST_REFERRAL_REPLY_MARKER = 'محتاجة متابعة من فريقنا المتخصص';

const systemPrompt = buildSystemPrompt([], null, false, null, false, null, [], '', null, false);

const cases = [
  {
    name: 'Full aging-concern profile, first turn (real prod over-trigger, chatId 22695194415336@lid)',
    contents: [
      { role: 'user', content: 'مختلطة وحساسة\nجفاف\nخطوط\nانتفاخ تحت العين\nترهلات' },
    ],
  },
  {
    name: 'Same aging concerns, customer follow-up giving budget (real prod over-trigger continuing)',
    contents: [
      { role: 'user', content: 'مختلطة وحساسة\nجفاف\nخطوط\nانتفاخ تحت العين\nترهلات' },
      {
        role: 'assistant',
        content:
          'تمام، ده موضوع عادي جدًا وهساعدك فيه زي أي استشارة تانية 💛 لو حابة تضيفي أي تفاصيل زي روتين العناية الحالي أو الميزانية التقريبية، هقدر أرشحلك أنسب منتج من عندنا فورًا.',
      },
      { role: 'user', content: 'الميزانية 500' },
    ],
  },
  {
    name: 'Bare "هيشد البشره ويحدد الجولاين" — real prod over-trigger, chatId 266090420654116@lid',
    contents: [{ role: 'user', content: 'هيشد البشره ويحدد الجولاين' }],
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
      // Mirror llmAgent.js's applyValidatedOutput exactly.
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
  console.log(`\n${totalFailures}/${totalRuns} runs still over-trigger on aging vocabulary (matching real llmAgent.js guard logic).`);
  process.exit(totalFailures > 0 ? 1 : 0);
})();
