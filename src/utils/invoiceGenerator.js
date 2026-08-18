const logger = require('./logger');
const { STORE_NAME } = require('../bot/llmSystemPrompt');
const { matchShippingZone } = require('../bot/shippingZones');
const productMatcher = require('../bot/productMatcher');

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Same diacritic/whitespace normalization llmAgent.js's productNameAppearsInReply
// already uses for exactly this kind of "compare a free-text product name
// against a catalog entry" job — kept as a local copy (not imported) since
// llmAgent.js pulls in a lot more than this file needs and importing back
// would risk a circular require (llmAgent.js -> llmSystemPrompt.js, which
// this file already requires).
function normalizeProductName(text) {
  return String(text || '')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// 2026-08-19 addition — Confirmed_Orders' "Products" column stores multiple
// items as one "A + B" string with a single combined Total Price (see
// campaignWorker.js's findOpenDraftOrderRow/updateConfirmedOrderItems merge
// path) — no per-item price was ever kept. Confirmed live, Confirmed_Orders
// row 14 (Hanan Ndy): the invoice showed one row for "بريتي وومن قلم كحل
// ثابت + غسول مويست-1 للبشرة العادية الحساسة والجافة" at the combined 270
// EGP, not the real 70/200 split the owner wanted visible.
//
// Rather than inventing a split (dividing the total evenly would show a
// wrong price for both real items whenever they differ, which they almost
// always do), each "+"-separated name is looked up against the LIVE catalog
// (productMatcher.getAllProducts(), already warmed in-process — no network
// call here) by exact name match after normalization — the same "ground a
// number in real data, never guess" discipline as every other price in this
// codebase (rule 8, validateModelOutput's price_quoted check). Only trusted
// when EVERY split part resolves to a real product AND their prices sum to
// within a 1 EGP rounding tolerance of the row's actual stored Total Price
// (protects against a stale/renamed catalog entry silently producing a
// wrong-but-plausible-looking breakdown) — otherwise falls back to the
// original single combined row, exactly the pre-existing behavior, so this
// can only improve on it, never show something wrong.
function buildLineItems({ products, productTotal, quantity }) {
  const rawTotal = parsePriceToNumber(productTotal);
  const fallbackQty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const fallbackLine = () => [
    {
      name: products || 'غير محدد',
      quantity: fallbackQty,
      unitPrice: fallbackQty > 0 ? rawTotal / fallbackQty : rawTotal,
      lineTotal: rawTotal,
    },
  ];

  const parts = String(products || '')
    .split(/\s*\+\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return fallbackLine();

  const catalog = productMatcher.getAllProducts();
  const resolved = parts.map((part) => {
    const target = normalizeProductName(part);
    const match = catalog.find((p) => normalizeProductName(String(p.name || '').split('(')[0]) === target);
    // Arabic-only display name, same reasoning as normalizeProductName's
    // matching above — catalog names carry a "(English translation)"
    // parenthetical the customer never sees in chat (the model only ever
    // writes the Arabic portion), so the split rows must match that, not
    // suddenly show the raw bilingual catalog string.
    return match ? { name: String(match.name || '').split('(')[0].trim(), price: parsePriceToNumber(match.price) } : null;
  });
  if (resolved.some((r) => !r)) return fallbackLine();

  const sum = resolved.reduce((s, r) => s + r.price, 0);
  if (Math.abs(sum - rawTotal) > 1) {
    logger.warn(
      `Invoice: split "${products}" into ${parts.length} real catalog products, but their prices (${sum}) don't sum to the row's stored Total Price (${rawTotal}) — showing the original combined row instead of a misleading breakdown.`
    );
    return fallbackLine();
  }

  return resolved.map((r) => ({ name: r.name, quantity: 1, unitPrice: r.price, lineTotal: r.price }));
}

// Prices throughout this system are free text typed straight into the
// Products/Order sheets, in this store's own convention (e.g. "120£",
// possibly "1,200 جنيه") — never guaranteed to be a clean number. Bug found
// 2026-08-02: `Number("120£")` is NaN, and the old `Number(amount) || 0`
// silently turned that into a 0 EGP line item with no warning — a real
// order's invoice showed only the shipping fee, the product itself "free".
// Strips everything except digits/decimal point/minus before parsing so a
// normally-formatted store price survives; only logs (and genuinely falls
// back to 0) when what's left truly isn't a number at all.
function parsePriceToNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    logger.warn(`Invoice: could not parse a numeric price out of "${value}" — showing 0 EGP for it. Check the source value's format.`);
    return 0;
  }
  return n;
}

function formatEgp(amount) {
  return `${parsePriceToNumber(amount).toLocaleString('en-US')} ج.م`;
}

// Rendered fresh per request by GET /invoice/:rowNumber (src/index.js) and
// printed straight from whatever browser opens it (Ctrl+P) — no PDF, no
// storage. RTL/Arabic shaping is handled natively by that browser, same as
// any other Arabic web page.
function buildInvoiceHtml({ invoiceNumber, dateLabel, customerName, phone, address, products, productTotal, shippingFeeOverrideEGP, shippingMethod, quantity, locationLink }) {
  const productTotalNum = parsePriceToNumber(productTotal);
  // 2026-08-19 addition — confirmed live (chatId 88876412584107@lid, phone
  // 201055990502): this line-item table used to hardcode "1" as the
  // quantity and show the SAME number for both unit price and line total
  // regardless of the real order size — so a 12-unit order's invoice looked
  // like a single 420 EGP item instead of "12 x 35 = 420". productTotal is
  // already the real, pre-multiplied grand total for this line (computed in
  // llmAgent.js, never done here) — quantity is only used to derive the
  // per-unit price for DISPLAY, dividing back out of that same total rather
  // than trusting a separately-stored unit price that could drift out of
  // sync with it. Defaults to 1 (unaffected, unit price == line total)
  // for every pre-quantity-feature order and any row where it's unset.
  //
  // 2026-08-19 — multi-product orders (see buildLineItems above) now render
  // as one row per real item instead of one combined row; a single-product
  // order (the common case) still gets exactly the quantity-aware row
  // described above, via buildLineItems' own fallback path.
  const lineItems = buildLineItems({ products, productTotal, quantity });
  // 2026-08-09 nationwide shipping expansion — the flat 60-EGP constant this
  // used to add is gone; the real fee now depends on the customer's actual
  // address, computed the same deterministic way everywhere else in this
  // codebase (shippingZones.js). An address that doesn't confidently match
  // any zone gets an honest "needs confirming" line rather than a wrong
  // number silently baked into the grand total.
  //
  // 2026-08-11 — Confirmed_Orders' 'Shipping Fee Override' column (staff/
  // admin per-order exception, e.g. a one-off free-shipping goodwill
  // gesture) takes precedence over the computed zone fee when set. `null`
  // (the getConfirmedOrderByRow convention for a blank cell) means "no
  // exception" — falls through to the normal computed fee; a real 0 is a
  // genuine free-shipping exception and must be honored as such, not
  // treated as "unset".
  const hasOverride = shippingFeeOverrideEGP !== null && shippingFeeOverrideEGP !== undefined && String(shippingFeeOverrideEGP).trim() !== '';
  const shippingZone = hasOverride ? null : matchShippingZone(address);
  // 2026-08-19 — Same-Day Express: only ever honored when there's no manual
  // override (that still wins outright, same as before) AND the zone itself
  // actually has an express fee — a stale/blank shippingZone (address
  // doesn't resolve) or a zone without expressFeeEGP (anywhere outside
  // Cairo/Giza) silently falls back to the normal computed fee rather than
  // ever inventing a number, same "code re-verifies, never trusts the stored
  // label alone" reasoning as llmAgent.js's resolveShippingMethod, which is
  // what wrote this Confirmed_Orders row's Shipping Method in the first
  // place — this is a second, independent check, not a redundant one, since
  // a Sheet cell can always be hand-edited by staff after the fact.
  const isExpress = !hasOverride && shippingMethod === 'express' && shippingZone && shippingZone.expressFeeEGP;
  const shippingFeeNum = hasOverride
    ? parsePriceToNumber(shippingFeeOverrideEGP)
    : shippingZone
    ? (isExpress ? shippingZone.expressFeeEGP : shippingZone.feeEGP)
    : 0;
  const shippingLabel = hasOverride
    ? `${formatEgp(shippingFeeNum)} (سعر استثنائي خاص بهذا الطلب)`
    : shippingZone
    ? `${formatEgp(shippingFeeNum)} (${escapeHtml(shippingZone.name)}${isExpress ? ' — Same-Day Express' : ''})`
    : 'هيتم تأكيدها من الفريق';
  const grandTotal = productTotalNum + shippingFeeNum;

  // 2026-08-19 design refresh (owner-requested: "clean, modern, professional,
  // mobile-friendly") + location-link display (see googleSheets.js's new
  // "Customer Location Link" column / llmAgent.js's session.orderData.
  // locationLink). Still zero-storage/rendered-fresh, still self-contained
  // (no external fonts/CDN — this is opened straight from a WhatsApp link on
  // a customer's phone, so it must never depend on a third-party request
  // succeeding), still print-friendly via the browser's own Ctrl+P (now with
  // a visible in-page button for it, hidden in the print output itself via
  // @media print). All pricing/shipping computation above is unchanged —
  // this only touches how it's presented.
  const locationLinkHtml = locationLink
    ? `<br><a class="location-link" href="${escapeHtml(locationLink)}" target="_blank" rel="noopener">📍 عرض موقع التوصيل</a>`
    : '';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>فاتورة ${escapeHtml(invoiceNumber)} — ${escapeHtml(STORE_NAME)}</title>
<style>
  :root {
    --brand: #d6336c;
    --brand-dark: #a61e4d;
    --ink: #2b2530;
    --muted: #8a8391;
    --line: #f0e2e7;
    --bg: #fbf4f6;
    --card: #ffffff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
    direction: rtl;
    color: var(--ink);
    background: var(--bg);
    padding: 32px 14px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 640px;
    margin: 0 auto;
    background: var(--card);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(166, 30, 77, .08);
  }
  .header { background: linear-gradient(135deg, var(--brand), var(--brand-dark)); color: #fff; padding: 30px 30px 26px; }
  .header h1 { margin: 0; font-size: 21px; font-weight: 700; }
  .header .sub { opacity: .85; font-size: 12px; margin-top: 6px; }
  .body-pad { padding: 26px 30px 8px; }
  .meta { display: flex; flex-wrap: wrap; gap: 18px 30px; padding-bottom: 6px; }
  .meta .block { font-size: 13px; line-height: 1.85; min-width: 150px; }
  .meta .label { color: var(--muted); font-size: 11px; display: block; margin-bottom: 2px; }
  .location-link { display: inline-block; margin-top: 4px; font-size: 12px; color: var(--brand-dark); text-decoration: none; font-weight: 600; }
  .location-link:hover { text-decoration: underline; }
  .table-wrap { overflow-x: auto; margin-top: 14px; border-radius: 10px; border: 1px solid var(--line); }
  table.items { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 420px; }
  table.items th { background: #fbeef2; text-align: right; padding: 11px 12px; font-weight: 600; color: var(--brand-dark); border-bottom: 1px solid var(--line); }
  table.items td { padding: 12px; border-bottom: 1px solid var(--line); }
  table.items tr:last-child td { border-bottom: none; }
  .totals { width: 100%; max-width: 300px; margin: 18px 0 0 auto; font-size: 13px; }
  .totals .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 7px 0; }
  .totals .row .val { white-space: nowrap; }
  .totals .row.grand { margin-top: 6px; padding-top: 14px; border-top: 2px solid var(--brand); }
  .totals .row.grand .lbl, .totals .row.grand .val { font-weight: 700; font-size: 17px; color: var(--brand-dark); }
  .print-btn {
    display: inline-flex; align-items: center; gap: 6px; margin: 22px 0 4px;
    background: var(--brand); color: #fff; border: none; padding: 10px 22px;
    border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer;
    font-family: inherit;
  }
  .print-btn:hover { background: var(--brand-dark); }
  .footer { padding: 20px 30px 26px; font-size: 11px; color: var(--muted); text-align: center; border-top: 1px solid var(--line); margin-top: 16px; }
  @media (max-width: 480px) {
    body { padding: 0; }
    .card { border-radius: 0; box-shadow: none; }
    .header { padding: 24px 18px; }
    .body-pad { padding: 20px 18px 4px; }
    .footer { padding: 18px; }
    table.items th, table.items td { padding: 9px; font-size: 12px; }
  }
  @media print {
    body { background: #fff; padding: 0; }
    .card { box-shadow: none; border-radius: 0; max-width: 100%; }
    .print-btn { display: none; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>${escapeHtml(STORE_NAME)} 🌸</h1>
      <div class="sub">فاتورة طلب — تم إصدارها تلقائياً</div>
    </div>
    <div class="body-pad">
      <div class="meta">
        <div class="block"><span class="label">رقم الفاتورة</span>${escapeHtml(invoiceNumber)}</div>
        <div class="block"><span class="label">التاريخ</span>${escapeHtml(dateLabel)}</div>
        <div class="block">
          <span class="label">بيانات العميلة</span>
          ${escapeHtml(customerName) || 'غير محدد'}<br>
          ${escapeHtml(phone) || 'غير محدد'}<br>
          ${escapeHtml(address) || 'العنوان غير مسجل بعد'}${locationLinkHtml}
        </div>
      </div>
      <div class="table-wrap">
        <table class="items">
          <thead><tr><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
          <tbody>
            ${lineItems
              .map(
                (item) =>
                  `<tr><td>${escapeHtml(item.name) || 'غير محدد'}</td><td>${item.quantity}</td><td>${formatEgp(item.unitPrice)}</td><td>${formatEgp(item.lineTotal)}</td></tr>`
              )
              .join('\n            ')}
          </tbody>
        </table>
      </div>
      <div class="totals">
        <div class="row"><span class="lbl">إجمالي المنتجات</span><span class="val">${formatEgp(productTotalNum)}</span></div>
        <div class="row"><span class="lbl">مصاريف الشحن</span><span class="val">${shippingLabel}</span></div>
        <div class="row grand"><span class="lbl">الإجمالي الكلي</span><span class="val">${formatEgp(grandTotal)}</span></div>
      </div>
      <button class="print-btn" onclick="window.print()">🖨️ طباعة الفاتورة</button>
    </div>
    <div class="footer">شكراً لثقتك في ${escapeHtml(STORE_NAME)} 🌸 — الفاتورة دي اتولدت أوتوماتيك، لو في أي استفسار تواصلي مع فريقنا.</div>
  </div>
</body>
</html>`;
}

module.exports = { buildInvoiceHtml, parsePriceToNumber };
