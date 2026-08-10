// Regression tests (not committed) for the 2026-08-09 nationwide shipping
// expansion (store owner directive — replaced the October-only flat-fee
// policy with a full governorate rate table). Covers:
// 1. shippingZones.js's deterministic matcher against real addresses seen
//    live this session (Nasr City, October, Sayeda Zeinab, ...).
// 2. Specific-tier-before-broad-Cairo/Giza ordering (Helwan/Shubra/Tagamoa
//    must never fall through to the generic Cairo/Giza tier).
// 3. buildSystemPrompt's grounded injection (known zone / unmatched address /
//    no address yet) — already spot-checked manually, re-verified here.
// 4. orderConfirmationSummary showing the real computed fee.
const assert = require('assert');
const { matchShippingZone, SHIPPING_ZONES } = require('../src/bot/shippingZones');
const { buildSystemPrompt } = require('../src/bot/llmSystemPrompt');
const { orderConfirmationSummary } = require('../src/bot/prompts');

(async () => {
  // --- 1. Real addresses seen live this session ---
  {
    const cases = [
      ['سيتي ستارز مدينه نصر بوابه 5', 'القاهرة والجيزة', 65],
      ['مدينه نصر مول سيتى ستارز الدور السادس', 'القاهرة والجيزة', 65],
      ['اكتوبر', 'أكتوبر – حدائق أكتوبر – الشيخ زايد', 50],
      ['العنوان السيده زينب مساكن زنهم ضهر البسطه عماره 177شقه 6', 'القاهرة والجيزة', 65],
    ];
    for (const [address, expectedName, expectedFee] of cases) {
      const zone = matchShippingZone(address);
      assert.ok(zone, `expected a match for "${address}"`);
      assert.strictEqual(zone.name, expectedName, `wrong zone for "${address}"`);
      assert.strictEqual(zone.feeEGP, expectedFee, `wrong fee for "${address}"`);
    }
    console.log('PASS: real addresses seen live this session match the correct zone/fee.');
  }

  // --- 2. Specific Greater-Cairo tiers must win over the broad Cairo/Giza catch-all ---
  {
    assert.strictEqual(matchShippingZone('حلوان شارع مصر حلوان').name, 'حلوان – 15 مايو');
    assert.strictEqual(matchShippingZone('شبرا الخيمة شارع الترعة').name, 'شبرا الخيمة – المرج – الخصوص – السلام');
    assert.strictEqual(matchShippingZone('التجمع الخامس').name, 'التجمع – مدينتي – الشروق – بدر');
    assert.strictEqual(matchShippingZone('مدينتي').name, 'التجمع – مدينتي – الشروق – بدر');
    console.log('PASS: specific Greater-Cairo tiers (Helwan/Shubra/Tagamoa) correctly win over the broad Cairo/Giza catch-all.');
  }

  // --- 2b. 2026-08-09 fix: substring-collision bugs found investigating a
  // real customer's (201038035190) invoice — short zone keywords like "قنا"
  // (Qena) and "بدر" (Badr) used to false-match INSIDE unrelated real place
  // names via containsAny's plain substring check. Fixed by switching to
  // containsWordSequence (whole-word/whole-phrase). ---
  {
    const qalyubiaViaQanater = matchShippingZone('القليوبية مركز شبين القناطر قرية كفر طحا');
    assert.ok(qalyubiaViaQanater, 'a Qalyubia address must resolve to a real zone now');
    assert.notStrictEqual(qalyubiaViaQanater.id, 'upper_south', 'BUG: "قنا" (Qena) must not false-match inside "القناطر" (Al Qanater)');
    assert.strictEqual(qalyubiaViaQanater.name, 'القاهرة والجيزة');

    const badrashin = matchShippingZone('بدرشين الجيزة');
    assert.notStrictEqual(badrashin.id, 'tagamoa', 'BUG: "بدر" (Badr) must not false-match inside "بدرشين" (Badrashin)');
    assert.strictEqual(badrashin.name, 'القاهرة والجيزة');

    // Standalone بدر (the real word, not embedded in another name) must
    // still correctly match tagamoa — the fix must not overcorrect into a
    // false negative for the legitimate case.
    assert.strictEqual(matchShippingZone('بدر مدينة').name, 'التجمع – مدينتي – الشروق – بدر');
    console.log('PASS: substring-collision bugs (قنا/القناطر, بدر/بدرشين) fixed, legitimate standalone بدر match unaffected.');
  }

  // --- 2c. 2026-08-09 fix: Qalyubia governorate itself (201038035190's real
  // address) was entirely missing from the table — store owner's call:
  // price it the same as Cairo/Giza (65 EGP). ---
  {
    const souad = matchShippingZone('القلج قليوبيه عند حلال ماركت موقف الاتوبيس');
    assert.ok(souad, 'Qalyubia address must now resolve to a zone instead of falling back to "needs manual confirmation"');
    assert.strictEqual(souad.name, 'القاهرة والجيزة');
    assert.strictEqual(souad.feeEGP, 65);
    console.log('PASS: Qalyubia governorate now resolves to Cairo/Giza (65 EGP) instead of an unresolved fee.');
  }

  // --- 3. Every tier from the owner's rate table is reachable and matches the exact fee ---
  {
    const probes = {
      october: 'الشيخ زايد الحي الثامن',
      tagamoa: 'الشروق',
      shubra_marg: 'الخصوص',
      helwan: '15 مايو',
      delta_canal: 'الاسكندرية سيدي جابر',
      upper_north: 'الفيوم',
      upper_south: 'اسيوط شارع الجمهورية',
      north_coast: 'مرسي مطروح',
      red_sea_new_valley: 'الغردقة',
      south_sinai: 'شرم الشيخ نعمة باي',
      cairo_giza: 'الدقي',
    };
    for (const zone of SHIPPING_ZONES) {
      const probe = probes[zone.id];
      assert.ok(probe, `no probe address defined for zone ${zone.id}`);
      const matched = matchShippingZone(probe);
      assert.ok(matched, `expected zone ${zone.id} to match probe "${probe}"`);
      assert.strictEqual(matched.feeEGP, zone.feeEGP, `fee mismatch for zone ${zone.id}`);
    }
    console.log('PASS: all 11 tiers from the owner\'s rate table are reachable with the exact specified fee.');
  }

  // --- 4. Unrecognized/no-location text: never guesses ---
  {
    assert.strictEqual(matchShippingZone(''), null);
    assert.strictEqual(matchShippingZone(null), null);
    assert.strictEqual(matchShippingZone('حي غير معروف خالص xyz'), null);
    console.log('PASS: unmatched/empty addresses correctly return null, never a guessed zone.');
  }

  // --- 5. buildSystemPrompt grounding (no address / known zone / unmatched address) ---
  {
    const noAddr = buildSystemPrompt([], null, { history: [] }, false, false, null, [], false, null, false, null);
    assert.ok(!noAddr.includes('بيانات شحن محسوبة فعلياً'), 'no grounded fee should be injected with no address yet');
    assert.ok(noAddr.includes('التوصيل متاح دلوقتي لكل محافظات مصر'), 'nationwide coverage statement must be present');

    const known = buildSystemPrompt([], null, { history: [] }, false, false, null, [], false, null, false, 'اكتوبر الحي الاول');
    assert.ok(known.includes('تكلفة الشحن 50 جنيه'), 'expected the grounded October fee to be injected');

    const unmatched = buildSystemPrompt([], null, { history: [] }, false, false, null, [], false, null, false, 'عنوان غريب جدا xyz123');
    assert.ok(unmatched.includes('مقدرش يحدد منطقة الشحن بالظبط'), 'expected the graceful unmatched-address instruction');
    console.log('PASS: buildSystemPrompt correctly grounds the shipping fee (or gracefully defers) based on address state.');
  }

  // --- 6. orderConfirmationSummary shows the real computed fee ---
  {
    const zone = matchShippingZone('اكتوبر');
    const summary = orderConfirmationSummary({ productName: 'صن بلوك', customerName: 'سارة', deliveryAddress: 'اكتوبر', shippingZone: zone });
    assert.ok(summary.includes('الشحن: 50 جنيه'), 'expected the confirmation summary to show the real zone fee');

    const summaryNoZone = orderConfirmationSummary({ productName: 'صن بلوك', customerName: 'سارة', deliveryAddress: 'عنوان غريب', shippingZone: null });
    assert.ok(!summaryNoZone.includes('الشحن:'), 'expected no shipping line at all when the zone is unmatched, not a blank/wrong one');
    console.log('PASS: orderConfirmationSummary shows the real computed fee, or omits the line entirely when unmatched.');
  }

  console.log('\nALL SHIPPING ZONE TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
