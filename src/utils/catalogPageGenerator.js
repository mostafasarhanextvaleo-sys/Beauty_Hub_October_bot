const { STORE_NAME } = require('../bot/llmSystemPrompt');

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CATEGORY_LABELS = {
  skincare: 'العناية بالبشرة',
  haircare: 'العناية بالشعر',
  makeup: 'ميك أب',
  bodycare: 'العناية بالجسم',
};
const CATEGORY_ORDER = ['skincare', 'haircare', 'makeup', 'bodycare'];

// Rendered fresh per request by GET /catalog (src/index.js), straight from
// productMatcher.getAllProducts() — the same in-process, auto-refreshed
// catalog every other feature in this codebase reads from, so this page can
// never drift out of sync with what Sara herself knows about. Deliberately
// filters to inStock only: this page's entire purpose is "browse, then quote
// the ID back to Sara in chat" (see productIdDetector.js/llmAgent.js's
// idMentionProduct), and quoting an out-of-stock id would just silently fall
// through there — showing it here would only invite a dead end.
function buildCatalogHtml(products) {
  const inStock = products.filter((p) => p.inStock !== false);
  const byCategory = new Map();
  inStock.forEach((p) => {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  });
  const categories = CATEGORY_ORDER.filter((c) => byCategory.has(c));

  const navHtml = categories
    .map((c) => `<a href="#cat-${c}" class="nav-chip">${escapeHtml(CATEGORY_LABELS[c] || c)}</a>`)
    .join('');

  const sectionsHtml = categories
    .map((c) => {
      const items = byCategory.get(c);
      const cardsHtml = items
        .map((p) => {
          const img = p.imageUrl
            ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.parentElement.classList.add('no-img')">`
            : '';
          return `<div class="card">
            <div class="thumb${p.imageUrl ? '' : ' no-img'}">${img}<span class="thumb-fallback">🌸</span></div>
            <div class="card-body">
              <div class="pname">${escapeHtml(p.name)}</div>
              <div class="pprice">${escapeHtml(p.price)}</div>
              <div class="pid">كود المنتج: <span class="pid-code">${escapeHtml(p.id)}</span></div>
            </div>
          </div>`;
        })
        .join('');
      return `<section id="cat-${c}">
        <h2>${escapeHtml(CATEGORY_LABELS[c] || c)}</h2>
        <div class="grid">${cardsHtml}</div>
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>كتالوج ${escapeHtml(STORE_NAME)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; direction: rtl; color: #222; margin: 0; background: #faf7f8; }
  .header { background: #28333e; color: #fff; padding: 22px 20px; text-align: center; }
  .header h1 { margin: 0; font-size: 20px; }
  .instructions { background: #fff3ef; color: #7a3b2e; padding: 14px 20px; font-size: 13px; text-align: center; line-height: 1.7; border-bottom: 1px solid #f0d9d0; }
  .instructions b { color: #c0392b; }
  .nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 20px; position: sticky; top: 0; background: #faf7f8; z-index: 5; border-bottom: 1px solid #eee; }
  .nav-chip { background: #fff; border: 1px solid #ddd; border-radius: 20px; padding: 6px 14px; font-size: 12px; color: #28333e; text-decoration: none; white-space: nowrap; }
  section { padding: 10px 20px 28px; }
  section h2 { font-size: 16px; border-right: 4px solid #c0392b; padding-right: 10px; margin: 18px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .card { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .thumb { aspect-ratio: 1; background: #f2ece9; display: flex; align-items: center; justify-content: center; position: relative; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .thumb-fallback { display: none; font-size: 32px; }
  .thumb.no-img img { display: none; }
  .thumb.no-img .thumb-fallback { display: block; }
  .card-body { padding: 8px 10px 10px; }
  .pname { font-size: 12.5px; line-height: 1.4; min-height: 34px; }
  .pprice { font-size: 13px; font-weight: bold; color: #c0392b; margin-top: 4px; }
  .pid { font-size: 11px; color: #888; margin-top: 6px; }
  .pid-code { font-family: 'Courier New', monospace; background: #f2f4f6; border-radius: 4px; padding: 1px 6px; color: #28333e; font-weight: bold; }
  .footer { text-align: center; font-size: 11px; color: #999; padding: 24px 20px 32px; }
</style>
</head>
<body>
  <div class="header"><h1>كتالوج ${escapeHtml(STORE_NAME)} 🌸</h1></div>
  <div class="instructions">شوفي المنتج اللي عايزاه وابعتي <b>كود المنتج</b> اللي تحته لينا في شات الواتساب، وسارة هتساعدك تكمّلي طلبك فورًا.</div>
  <div class="nav">${navHtml}</div>
  ${sectionsHtml}
  <div class="footer">${escapeHtml(STORE_NAME)} — الكتالوج ده بيتحدث تلقائي مع كل تحديث في المنتجات.</div>
</body>
</html>`;
}

module.exports = { buildCatalogHtml };
