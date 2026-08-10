const logger = require('./logger');
const { STORE_NAME } = require('../bot/llmSystemPrompt');
const { matchShippingZone } = require('../bot/shippingZones');

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
function buildInvoiceHtml({ invoiceNumber, dateLabel, customerName, phone, address, products, productTotal }) {
  const productTotalNum = parsePriceToNumber(productTotal);
  // 2026-08-09 nationwide shipping expansion — the flat 60-EGP constant this
  // used to add is gone; the real fee now depends on the customer's actual
  // address, computed the same deterministic way everywhere else in this
  // codebase (shippingZones.js). An address that doesn't confidently match
  // any zone gets an honest "needs confirming" line rather than a wrong
  // number silently baked into the grand total.
  const shippingZone = matchShippingZone(address);
  const shippingFeeNum = shippingZone ? shippingZone.feeEGP : 0;
  const shippingLabel = shippingZone
    ? `${formatEgp(shippingFeeNum)} (${escapeHtml(shippingZone.name)})`
    : 'هيتم تأكيدها من الفريق';
  const grandTotal = productTotalNum + shippingFeeNum;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; color: #222; margin: 0; }
  .header { background: #28333e; color: #fff; padding: 28px 36px; }
  .header h1 { margin: 0; font-size: 22px; }
  .header .sub { opacity: .75; font-size: 12px; margin-top: 6px; }
  .meta { display: flex; justify-content: space-between; gap: 24px; padding: 22px 36px; }
  .meta .block { font-size: 13px; line-height: 1.9; }
  .meta .label { color: #888; font-size: 11px; display: block; }
  table.items { width: calc(100% - 72px); margin: 0 36px; border-collapse: collapse; font-size: 13px; }
  table.items th { background: #f2f4f6; text-align: right; padding: 10px 12px; border-bottom: 2px solid #28333e; }
  table.items td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
  .totals { width: 260px; margin: 18px 36px 0 auto; font-size: 13px; }
  .totals tr td { padding: 6px 4px; }
  .totals tr.grand td { font-weight: bold; font-size: 15px; border-top: 2px solid #28333e; padding-top: 10px; }
  .footer { padding: 28px 36px; font-size: 11px; color: #999; }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(STORE_NAME)} 🌸</h1>
    <div class="sub">فاتورة طلب — تم إصدارها تلقائياً</div>
  </div>
  <div class="meta">
    <div class="block"><span class="label">رقم الفاتورة</span>${escapeHtml(invoiceNumber)}</div>
    <div class="block"><span class="label">التاريخ</span>${escapeHtml(dateLabel)}</div>
    <div class="block"><span class="label">بيانات العميلة</span>${escapeHtml(customerName) || 'غير محدد'}<br>${escapeHtml(phone) || 'غير محدد'}<br>${escapeHtml(address) || 'العنوان غير مسجل بعد'}</div>
  </div>
  <table class="items">
    <thead><tr><th>المنتج</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
    <tbody>
      <tr><td>${escapeHtml(products) || 'غير محدد'}</td><td>1</td><td>${formatEgp(productTotalNum)}</td><td>${formatEgp(productTotalNum)}</td></tr>
    </tbody>
  </table>
  <table class="totals">
    <tr><td>إجمالي المنتجات</td><td>${formatEgp(productTotalNum)}</td></tr>
    <tr><td>مصاريف الشحن</td><td>${shippingLabel}</td></tr>
    <tr class="grand"><td>الإجمالي الكلي</td><td>${formatEgp(grandTotal)}</td></tr>
  </table>
  <div class="footer">شكراً لثقتك في ${escapeHtml(STORE_NAME)} 🌸 — الفاتورة دي اتولدت أوتوماتيك، لو في أي استفسار تواصلي مع فريقنا.</div>
</body>
</html>`;
}

module.exports = { buildInvoiceHtml };
