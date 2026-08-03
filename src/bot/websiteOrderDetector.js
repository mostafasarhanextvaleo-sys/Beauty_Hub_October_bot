// Recognizes the automated WhatsApp order message SpreadSimple (the store's
// catalog website, see llmSystemPrompt.js's WEBSITE_URL) generates when a
// customer completes checkout there. Requires BOTH the opening phrase AND an
// "Order #:" reference together — neither alone is a safe signal (plain text
// over WhatsApp has no cryptographic link to a real completed transaction,
// so a loose match risks a spoofed/mistyped message being treated as a real
// order). This is why llmAgent.js logs a recognized message as "Pending -
// Website Order", not "Completed" — a human still glances at it before
// dispatch. Real example (2026-07-30 test order):
//
// Hello, I'd like to place my order:
// * 1 × 170£ | ديرماتيك غسول للبشرة الدهنية والمختلطة Dermatique Purifying Cleansing Gel
//
// Total: 170 £
//
// Name: mostafa sarhan
// Phone: 01098175119
// Email: mostafasarhanextvaleo@gmail.com
//
// Order #: E3VRGZW
//
// Order notes: Test
const ORDER_PHRASE_RE = /i'?d like to place my order/i;
const ORDER_NUMBER_RE = /order\s*#:\s*(\S+)/i;
const TOTAL_RE = /total:\s*([\d.,]+)\s*£/i;
const NAME_RE = /name:\s*(.+)/i;
const PHONE_RE = /phone:\s*(.+)/i;
const EMAIL_RE = /email:\s*(.+)/i;
const NOTES_RE = /order notes:\s*([\s\S]*)/i;
// "×" is the template's real separator; "x"/"X" accepted too in case of
// minor client/font variation — only affects line-item extraction quality,
// never the core recognition above, so being a bit loose here is low-risk.
const ITEM_LINE_RE = /^\*\s*(\d+)\s*[×xX]\s*([\d.,]+)\s*£?\s*\|\s*(.+)$/gm;

// Returns null if this isn't a recognized website order message, otherwise
// { orderNumber, totalPrice, customerName, phone, email, orderNotes, items }.
function parseWebsiteOrder(text) {
  if (!text) return null;
  if (!ORDER_PHRASE_RE.test(text) || !ORDER_NUMBER_RE.test(text)) return null;

  const orderNumberMatch = text.match(ORDER_NUMBER_RE);
  const totalMatch = text.match(TOTAL_RE);
  const nameMatch = text.match(NAME_RE);
  const phoneMatch = text.match(PHONE_RE);
  const emailMatch = text.match(EMAIL_RE);
  const notesMatch = text.match(NOTES_RE);

  const items = [];
  let m;
  // Reset lastIndex — ITEM_LINE_RE is a module-level regex with the global
  // flag, so its lastIndex persists across calls unless cleared first.
  ITEM_LINE_RE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = ITEM_LINE_RE.exec(text)) !== null) {
    items.push({ qty: parseInt(m[1], 10) || 1, unitPrice: m[2].trim(), name: m[3].trim() });
  }

  return {
    orderNumber: orderNumberMatch ? orderNumberMatch[1].trim() : '',
    totalPrice: totalMatch ? totalMatch[1].trim() : '',
    customerName: nameMatch ? nameMatch[1].trim() : '',
    phone: phoneMatch ? phoneMatch[1].trim() : '',
    email: emailMatch ? emailMatch[1].trim() : '',
    orderNotes: notesMatch ? notesMatch[1].trim() : '',
    items,
  };
}

function summarizeItems(items) {
  if (!items || items.length === 0) return '';
  return items.map((it) => `${it.qty} × ${it.name} (${it.unitPrice}£)`).join('، ');
}

module.exports = { parseWebsiteOrder, summarizeItems };
