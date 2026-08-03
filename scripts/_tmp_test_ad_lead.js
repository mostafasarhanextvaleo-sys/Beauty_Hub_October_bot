// Verifies the 2026-08-04 Facebook ad-lead trigger (Dermatique Sun SPF 50):
// adLeadDetector's matching, and campaignWorker.tagAdLead's three
// Targeted_Clients scenarios (new contact / existing PENDING / existing
// already-progressed). The LLM-context piece (session.recommendedProduct +
// the one-shot ad-landing system-prompt section) was verified live against
// the real catalog and real OpenAI call — see the conversation this shipped
// in for the actual transcript (correct product, correct 300£ price,
// grounded benefits, one-shot greeting not repeated on the 2nd turn) —
// covering that here would require stubbing most of llmAgent.js's
// dependency graph (productSearch, campaignKnowledge, agentStats,
// trainingDataLogger, both AI tiers) for comparatively little regression
// value beyond what these two cheaper, deterministic checks already cover.
const assert = require('assert');
const adLeadDetector = require('../src/bot/adLeadDetector');

// --- adLeadDetector ---
(function testDetector() {
  const campaign = adLeadDetector.detectAdCampaign('مرحبًا، جئت من إعلان Dermatique Sun SPF 50.');
  assert.ok(campaign, 'expected the exact ad text to match');
  assert.strictEqual(campaign.id, 'facebook_dermatique_sun_spf50_gel');
  assert.strictEqual(campaign.productId, '19');

  // Customer adding extra text after the pre-filled message must still match.
  const withExtra = adLeadDetector.detectAdCampaign('مرحبًا، جئت من إعلان Dermatique Sun SPF 50. عايزة اعرف السعر');
  assert.ok(withExtra, 'expected a match even with extra trailing text');

  assert.strictEqual(adLeadDetector.detectAdCampaign('عايزة اسأل عن غسول للبشرة الدهنية'), null, 'unrelated text must not match');
  assert.strictEqual(adLeadDetector.detectAdCampaign(''), null, 'empty text must not match');
  console.log('PASS: adLeadDetector matches the exact ad text (with or without trailing customer text) and rejects unrelated messages.');
})();

// --- campaignWorker.tagAdLead ---
(async function testTagAdLead() {
  const googleSheetsPath = require.resolve('../src/services/googleSheets');
  const productMatcherPath = require.resolve('../src/bot/productMatcher');

  const rows = [
    { rowNumber: 2, chatId: 'EXISTING_PENDING@lid', phoneNumber: '1', customerName: 'Old Name', category: 'old category', campaignStatus: 'PENDING', leadSource: 'generic capture', recencyTier: '', touches: 0, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '' },
    { rowNumber: 3, chatId: 'EXISTING_ORDERED@lid', phoneNumber: '2', customerName: 'Ordered Customer', category: 'old category', campaignStatus: 'ORDERED', leadSource: 'old real order', recencyTier: '', touches: 0, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '2026-01-01T00:00:00.000Z', offerSent: '' },
  ];
  const upsertCalls = [];
  const googleSheetsStub = {
    async getTargetedClientsRows() { return rows.map((r) => ({ ...r })); },
    async upsertTargetedClient(chatId, fields) {
      upsertCalls.push({ chatId, fields });
      const existing = rows.find((r) => r.chatId === chatId);
      if (existing) Object.assign(existing, fields);
      else rows.push({ rowNumber: rows.length + 2, chatId, ...fields });
    },
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

  const productMatcherStub = { getById(id) { return id === '19' ? { id: '19', name: 'صن بلوك جل ديرماتيك (Dermatique Sunblock Gel SPF 50)', price: '300£' } : null; } };
  require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: productMatcherStub };

  delete require.cache[require.resolve('../src/bot/campaignWorker')];
  const campaignWorker = require('../src/bot/campaignWorker');
  const adText = 'مرحبًا، جئت من إعلان Dermatique Sun SPF 50.';

  await campaignWorker.tagAdLead('NEW_CONTACT@lid', { phone: '201000000099', senderName: 'New', text: adText });
  const newRow = rows.find((r) => r.chatId === 'NEW_CONTACT@lid');
  assert.strictEqual(newRow.campaignStatus, 'PENDING');
  assert.strictEqual(newRow.leadSource, 'Facebook Ad - Dermatique Sun SPF 50');
  assert.strictEqual(newRow.category, 'صن بلوك جل ديرماتيك (Dermatique Sunblock Gel SPF 50)');
  console.log('PASS: a brand-new contact is inserted as PENDING with the ad-specific Lead Source/category.');

  await campaignWorker.tagAdLead('EXISTING_PENDING@lid', { phone: '1', senderName: 'x', text: adText });
  const pendingRow = rows.find((r) => r.chatId === 'EXISTING_PENDING@lid');
  assert.strictEqual(pendingRow.leadSource, 'Facebook Ad - Dermatique Sun SPF 50', 'expected leadSource to be updated on an existing PENDING row');
  assert.strictEqual(pendingRow.campaignStatus, 'PENDING', 'status must stay PENDING, not be reset/reinserted');
  console.log('PASS: an existing PENDING row gets its Lead Source/category updated without resetting anything else.');

  await campaignWorker.tagAdLead('EXISTING_ORDERED@lid', { phone: '2', senderName: 'x', text: adText });
  const orderedRow = rows.find((r) => r.chatId === 'EXISTING_ORDERED@lid');
  assert.strictEqual(orderedRow.leadSource, 'old real order', 'an already-progressed (ORDERED) row must never be touched');
  assert.strictEqual(orderedRow.category, 'old category');
  console.log('PASS: an existing ORDERED row is left completely untouched.');

  const callsForOrdered = upsertCalls.filter((c) => c.chatId === 'EXISTING_ORDERED@lid');
  assert.strictEqual(callsForOrdered.length, 0, 'expected zero upsertTargetedClient calls for the already-progressed contact');

  await campaignWorker.tagAdLead('NEW_CONTACT@lid', { phone: '201000000099', senderName: 'x', text: 'رسالة عادية مش من اعلان' });
  assert.strictEqual(upsertCalls.filter((c) => c.chatId === 'NEW_CONTACT@lid').length, 1, 'a non-ad message must be a complete no-op (no extra upsert call)');
  console.log('PASS: a non-matching message is a no-op.');

  console.log('\nALL AD-LEAD TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
