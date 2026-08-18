const { containsWordSequence } = require('../utils/helpers');

// 2026-08-09 — nationwide shipping expansion (store owner directive,
// replacing the October-only flat-fee policy). Deterministic, code-level
// zone matching — same "never let the model invent a number, ground it in
// real data" philosophy already used for product prices/availability
// throughout this codebase (see llmSystemPrompt.js rule 8, validateModelOutput's
// price_quoted check) — a shipping fee is exactly the kind of fact the LLM
// must never compute or guess on its own from a table buried in the prompt.
//
// Ordered from MOST to LEAST specific: several of these areas (حلوان, شبرا
// الخيمة, التجمع, مدينتي...) are technically part of Greater Cairo but have
// their OWN distinct tier in the owner's rate table, so they must be checked
// BEFORE the broad "القاهرة والجيزة" catch-all — matchShippingZone always
// returns the FIRST (most specific) zone whose keywords appear, never the
// broadest one that happens to also match.
const SHIPPING_ZONES = [
  {
    id: 'october',
    name: 'أكتوبر – حدائق أكتوبر – الشيخ زايد',
    feeEGP: 50,
    keywords: ['اكتوبر', 'حدائق اكتوبر', 'الشيخ زايد', 'زايد', '6 اكتوبر', 'سادس اكتوبر'],
  },
  {
    id: 'tagamoa',
    name: 'التجمع – مدينتي – الشروق – بدر',
    feeEGP: 75,
    keywords: ['التجمع', 'تجمع', 'مدينتي', 'الشروق', 'بدر'],
  },
  {
    id: 'shubra_marg',
    name: 'شبرا الخيمة – المرج – الخصوص – السلام',
    feeEGP: 70,
    keywords: ['شبرا الخيمة', 'المرج', 'الخصوص', 'مدينة السلام', 'حي السلام'],
  },
  {
    id: 'helwan',
    name: 'حلوان – 15 مايو',
    feeEGP: 70,
    keywords: ['حلوان', '15 مايو', 'خمستاشر مايو'],
  },
  {
    id: 'delta_canal',
    name: 'وجه بحري ومدن القناة',
    feeEGP: 85,
    keywords: [
      'الاسكندرية',
      'اسكندريه',
      'دمياط',
      'بورسعيد',
      'بور سعيد',
      'الاسماعيلية',
      'اسماعيليه',
      'السويس',
      'كفر الشيخ',
      'دمنهور',
      'البحيرة',
      'رشيد',
      'الغربية',
      'طنطا',
      'المنصورة',
      'الدقهلية',
      'المحلة',
      'زفتى',
    ],
  },
  {
    id: 'upper_north',
    name: 'الفيوم – المنيا – بني سويف',
    feeEGP: 95,
    keywords: ['الفيوم', 'فيوم', 'المنيا', 'منيا', 'بني سويف'],
  },
  {
    id: 'upper_south',
    name: 'أسيوط – سوهاج – قنا – الأقصر – أسوان',
    feeEGP: 100,
    keywords: ['اسيوط', 'سوهاج', 'قنا', 'الاقصر', 'اقصر', 'اسوان'],
  },
  {
    id: 'north_coast',
    name: 'الساحل الشمالي – مرسى مطروح',
    feeEGP: 115,
    keywords: ['الساحل الشمالي', 'ساحل شمالي', 'مرسي مطروح', 'مطروح'],
  },
  {
    id: 'red_sea_new_valley',
    name: 'البحر الأحمر – الوادي الجديد',
    feeEGP: 135,
    keywords: ['البحر الاحمر', 'بحر احمر', 'الغردقة', 'غردقة', 'الوادي الجديد', 'الخارجة'],
  },
  {
    id: 'south_sinai',
    name: 'جنوب سيناء',
    feeEGP: 160,
    keywords: ['جنوب سيناء', 'شرم الشيخ', 'دهب', 'نويبع', 'طابا'],
  },
  // Deliberately LAST and broadest — every specific Greater-Cairo tier above
  // (helwan, shubra_marg, tagamoa) is checked first, so a Nasr City/Maadi/
  // Dokki-style address correctly falls through to here rather than one of
  // those more specific (and differently priced) tiers.
  //
  // 2026-08-19 (store owner directive): Same-Day Express is a flat, fixed
  // alternative to this zone's standard 65 EGP fee — NOT an extra add-on
  // charged on top of it — available only in this one zone. expressFeeEGP is only
  // ever set on this zone object; every downstream reader (buildShippingZoneSection
  // below, and matchShippingZone's return value) treats its absence/null as
  // "no express option here," so Cairo/Giza doesn't need a parallel
  // allow-list to stay in sync with.
  {
    id: 'cairo_giza',
    name: 'القاهرة والجيزة',
    feeEGP: 65,
    expressFeeEGP: 100,
    keywords: [
      'القاهرة',
      'قاهرة',
      'الجيزة',
      'جيزة',
      'مدينة نصر',
      'مدينه نصر',
      'المعادي',
      'الدقي',
      'الدقى',
      'المهندسين',
      'مصر الجديدة',
      'هليوبوليس',
      'وسط البلد',
      'الزمالك',
      'فيصل',
      'الهرم',
      'العجوزة',
      'حدائق القبة',
      'عين شمس',
      'شبرا',
      'السيدة زينب',
      'سيتي ستارز',
      // 2026-08-09 fix — found investigating a real customer's (201038035190)
      // invoice showing an unresolved shipping fee: Qalyubia governorate had
      // no zone entry at all (shubra_marg only covers one Qalyubia city,
      // Shubra Al-Kheima, not the governorate generally). Store owner's
      // call: price it the same as Cairo/Giza (65 EGP) rather than a new
      // tier. normalizeArabic already collapses ة/ه, so 'القليوبية' also
      // matches the address's real spelling 'قليوبيه'.
      'القليوبية',
      'قليوبية',
    ],
  },
];

// Returns { id, name, feeEGP } for the first (most specific) zone whose
// keywords appear in the given address text, or null if nothing confidently
// matches — a null result must never be treated as "assume some default fee"
// by any caller; it means "ask the team to confirm" (same convention as
// price/availability elsewhere in this codebase), not "guess."
//
// Uses containsWordSequence (whole-word/whole-phrase, see helpers.js), not a
// raw substring check — 2026-08-09 fix: a plain substring check let short
// keywords like "قنا" (Qena) false-match inside unrelated real place names
// like "القناطر" (Al Qanater), silently charging the wrong shipping tier.
function matchShippingZone(addressText) {
  if (!addressText) return null;
  for (const zone of SHIPPING_ZONES) {
    if (containsWordSequence(addressText, zone.keywords)) {
      return { id: zone.id, name: zone.name, feeEGP: zone.feeEGP, expressFeeEGP: zone.expressFeeEGP || null };
    }
  }
  return null;
}

module.exports = { SHIPPING_ZONES, matchShippingZone };
