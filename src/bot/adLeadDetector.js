// Recognizes the pre-filled text a Meta "Click-to-WhatsApp" ad sends
// automatically the instant a customer taps "Send Message" on the ad —
// before they've typed anything themselves. That text is exactly what the
// advertiser configured in Ads Manager, so an exact substring match (not
// normalizeArabic's fuzzy typo/dialect handling, which exists for real
// customer text, not literal bot-to-bot boilerplate) is the right tool here.
//
// A small list rather than a single hardcoded check so the next ad campaign
// is a one-line addition, not a new code path — see AD_CAMPAIGNS below.
//
// 2026-08-04: first entry is the "Dermatique Sun SPF 50" ad. Deliberately
// points at catalog id '19' (صن بلوك جل ديرماتيك / Dermatique Sunblock GEL
// SPF 50, 300£) rather than id '18' (the non-gel SPF 50, 250£) — confirmed
// with the store owner: the ad's own described benefits ("light texture,
// fast absorption") match id 19's real catalog description, not id 18's
// (which is the opposite — a rich, nourishing formula). Grounding in the
// wrong SKU here would have the bot confidently misdescribe a real product
// to every ad click, so this mapping must never be guessed from the ad's
// product name alone without checking the catalog description too.
const AD_CAMPAIGNS = [
  {
    id: 'facebook_dermatique_sun_spf50_gel',
    matchText: 'مرحبًا، جئت من إعلان Dermatique Sun SPF 50.',
    leadSource: 'Facebook Ad - Dermatique Sun SPF 50',
    productId: '19',
  },
];

function detectAdCampaign(text) {
  const normalized = (text || '').trim();
  if (!normalized) return null;
  return AD_CAMPAIGNS.find((c) => normalized.includes(c.matchText)) || null;
}

module.exports = { detectAdCampaign, AD_CAMPAIGNS };
