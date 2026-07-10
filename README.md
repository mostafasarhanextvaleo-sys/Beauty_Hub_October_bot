# Beauty Hub October — WhatsApp Sales Bot

A rule-based WhatsApp sales chatbot for **Beauty Hub October**, a cosmetics, skincare, haircare, makeup, and body care store. The bot chats with customers in natural Egyptian Arabic, recommends products, detects purchase intent, and logs leads/orders into Google Sheets.

## 1. Prerequisites

- Node.js 18 or newer
- A WhatsApp account/phone to scan the QR code (Linked Devices)
- (Optional) A Google Cloud service account if you want Google Sheets logging

## 2. Installation

```bash
npm install
```

## 3. Setup

1. Copy the environment file:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in:
   - `GOOGLE_SHEET_ID` — only needed if you want Google Sheets logging.
   - Leave `AI_PROVIDER=none` to use the built-in rule-based Egyptian-Arabic sales agent (no API key required).
3. If you want Google Sheets logging, add your `credentials.json` (see section 6 below). If it's missing, the bot will print a warning and keep running as a WhatsApp-only bot — it will not crash.

## 4. Start the bot

```bash
npm start
```

## 5. Scan the WhatsApp QR code

1. Open WhatsApp on your phone.
2. Go to **Settings > Linked Devices**.
3. Tap **Link a Device**.
4. Scan the QR code printed in the terminal.

Once scanned, the session is stored in the folder defined by `SESSION_PATH` (default `./.wwebjs_auth`) so you won't need to scan again unless the session is removed or expires.

## 6. Google Sheets setup (optional but recommended)

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (or use an existing one).
2. Create a **Service Account** under "IAM & Admin > Service Accounts".
3. Enable the **Google Sheets API** for the project.
4. Create a JSON key for the service account and download it.
5. Rename the downloaded file to `credentials.json` and place it in the project root (see `credentials.example.json` for the expected shape).
6. Open your target Google Sheet and **share it with the service account's email address** (found inside `credentials.json` as `client_email`), giving it **Editor** access.
7. Copy the Sheet ID from its URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`) into `GOOGLE_SHEET_ID` in `.env`.

On first run, the bot automatically creates two tabs in your spreadsheet if they don't already exist:

- **Leads** — one row per lead/order, with header:
  `Date | Customer Name | Customer WhatsApp Number | Customer Message | Product Name | Customer Need | Order Status | Delivery Address | Notes`
- **Products** — your live product catalog (see section 8 below). It's auto-seeded with the starter products from `products.json` the first time it's created.

## 7. Health check

- `GET /` → `Beauty Hub October WhatsApp Bot is running`
- `GET /health` → JSON with WhatsApp status, Google Sheets status (including `lastSuccessAt` and a `stale` flag — `true` if nothing has synced successfully in 30+ minutes, so a connectivity problem shows up here instead of only in logs), and which product source is active (`local` or `google-sheets`) with a product count.
- `GET /reload-products` → forces an immediate re-read of the "Products" tab from Google Sheets (no restart needed).

Default: http://localhost:3000/health

If Sheets syncing stays broken for 30+ minutes, a warning is also logged once (not repeatedly) — check `pm2 logs beauty-hub-bot` for `"Google Sheets has not synced successfully..."`.

## 8. Managing products

You have two options — the bot always keeps `products.json` as a safety fallback.

### Option A — Google Sheets (recommended once configured)

Once Google Sheets is set up (section 6), edit the **Products** tab directly in your spreadsheet. Columns:

| ID | Name | Category | Price | Description | Benefits | Skin Type | Hair Type | In Stock |
|----|------|----------|-------|--------------|----------|-----------|-----------|----------|

- `Category` must be exactly one of: `skincare`, `haircare`, `makeup`, `bodycare`.
- `Benefits`, `Skin Type`, `Hair Type` — comma-separated values, e.g. `oily, combination` or `dry, frizzy`.
  - Valid `Skin Type` values: `oily`, `dry`, `combination`, `sensitive`.
  - Valid `Hair Type` values: `dry`, `frizzy`, `damaged`, `falling`, `dandruff`.
- `In Stock` — `TRUE` or `FALSE` (defaults to `TRUE` if left blank).
- Rows with an invalid/blank `Category` are skipped and logged as a warning — they won't crash the bot.

The bot re-reads this tab automatically every 5 minutes, or instantly if you call `GET /reload-products`. If Google Sheets becomes unreachable or is not configured, the bot automatically falls back to the last-loaded product list (or `products.json` if it never loaded from Sheets).

### Option B — local file

Edit `products.json` in the project root. Each product looks like:

```json
{
  "id": "1",
  "name": "Example Product",
  "category": "skincare",
  "price": "",
  "description": "",
  "benefits": [],
  "skinType": [],
  "hairType": [],
  "inStock": true
}
```

`category` must be one of: `skincare`, `haircare`, `makeup`, `bodycare`. Restart the bot after editing this file for changes to take effect.

## 9. Chat history log

Every incoming customer message and every outgoing bot reply is appended to `chat_history.log` in the project root as **JSON Lines** — one JSON object per line, ready to parse directly for analytics (funnel/stage progression, response latency) instead of scraping text:

```json
{"ts":"2026-07-10T10:15:23.456Z","dir":"IN","chatId":"201098175119@c.us","phone":"201098175119","name":"سارة","stage":"AWAIT_ATTRIBUTE","text":"دهنية"}
{"ts":"2026-07-10T10:15:23.789Z","dir":"OUT","chatId":"201098175119@c.us","phone":"201098175119","name":"سارة","stage":"RECOMMENDED","text":"...","latencyMs":333}
```

Fields: `ts` (timestamp), `dir` (`IN`/`OUT`), `chatId`/`phone`/`name`, `stage` (the conversation's state machine stage — `IN` lines show the stage *before* handling the message, `OUT` lines show the stage *after*, so you can reconstruct the funnel and see exactly where customers drop off), `text`, `latencyMs` (reply time, `OUT` lines only), and `variantId` (`OUT` lines only — see section 12, "A/B message variants"). Use this file to review real conversations, tune `src/bot/prompts.js`, or build a dashboard. The file is excluded from git via `.gitignore` (`*.log`) since it contains customer message content.

Note: if you have an older `chat_history.log` from before this format change, it will contain a mix of the old plain-text lines and new JSON lines — any parser should treat non-JSON lines as legacy entries.

**Rotation**: the file auto-rotates once it exceeds 10MB, keeping up to 5 backups (`chat_history.log.1` ... `.5`, oldest dropped), so it can't silently fill up your disk over time.

**Media messages** (images, voice notes, videos, documents, stickers) are logged too, tagged like `[صورة]` — see section 11.

## 10. Cart-recovery follow-up

If a customer gets a product recommendation, is asked for their name/address, or is asked to confirm their order — and then goes quiet — the bot automatically sends one friendly follow-up after `CART_NUDGE_DELAY_HOURS` (default 3 hours, set in `.env`) mentioning the specific product they were shown. It sends at most one nudge per idle period — if the customer replies and then goes quiet again later, a fresh nudge can fire again. This runs on a 15-minute background check (`src/bot/cartRecovery.js`) and requires no setup beyond the env var.

## 11. Common questions (FAQ) and order confirmation

**FAQ handling.** If a customer asks a common question instead of making a decision — price, delivery time/cost, ingredients, or available colors/sizes — the bot answers directly instead of giving a generic "still deciding" reply, and without inventing facts it doesn't have:

- **Price**: answers with the real price if it's set in the sheet; otherwise says a team member will confirm it (same "never invent" rule as everywhere else).
- **Delivery, ingredients, availability**: gives an honest answer using whatever's in the product's `Description`, or says the team will confirm — the bot never guesses delivery times/costs or ingredient specifics it doesn't actually have.

This also fixes a subtly important case: if a customer asks a question *while the bot is waiting for their name and address*, the question is answered and the bot stays in that step — it no longer risks treating the question text itself as if it were the delivery address.

**Order confirmation step.** Before an order is marked "Completed" in the **Leads** sheet, the bot now repeats back the product, name, and address it captured and asks the customer to confirm ("البيانات دي صح؟"):

- Customer confirms (`تمام`, `ايوه`, `موافق`, ...) → order marked **Completed**.
- Customer says it's wrong (`لأ`, `غلط`, `مش صح`, ...) → the bot asks for the name/address again and re-confirms once corrected.
- Customer asks a question instead → answered via the FAQ handling above, without disrupting the confirmation.

This closes a gap where any text sent right after the address request — including a typo'd address or an unrelated question — was previously marked as a completed order immediately.

## 12. Media messages (photos, voice notes, etc.)

If a customer sends a photo, voice note, video, document, or sticker, the bot never goes silent:

- **No caption**: replies honestly that it can't yet see/hear that type of media (for images/video/voice/audio specifically) and asks the customer to describe their need in text; other types get the normal "tell me what you need" prompt. Conversation stage and the Leads sheet are left untouched, since nothing about the customer's need actually changed.
- **With a caption**: the caption text is processed completely normally (recommendations, FAQs, everything works) — the bot just adds a short note upfront that it didn't see the attached media itself.

This is intentionally the safe, always-on tier (no AI dependency, no extra cost). Actual image *analysis* (a vision model describing what's in a photo of skin/hair) is a separate, bigger feature that isn't built yet — ask if you want it, since it requires enabling `AI_PROVIDER` with a vision-capable model and has real per-image API cost.

## 13. Admin notifications

Set `ADMIN_WHATSAPP_NUMBER` in `.env` (a phone number with country code, e.g. `201098175119`, no `+`) to get a WhatsApp message sent to that number automatically when:

- **An order is completed** — product, customer name, phone, and address, right after the customer confirms.
- **A customer needs something not in the catalog** — so you can follow up manually or add the product, instead of only finding out by checking the Leads sheet later.

Leave it blank (the default) to disable — nothing is sent and nothing else changes. Startup logs confirm whether this is enabled: check `pm2 logs beauty-hub-bot` for `"Admin notifications enabled/disabled"`.

## 14. A/B message variants

The greeting and the product-recommendation call-to-action ("تحبي أحجزهولك؟") each have 3 wording variants (`src/bot/prompts.js` — `GREETING_VARIANTS`, `RECOMMENDATION_CTA_VARIANTS`). One is picked at random each time and its `variantId` (e.g. `greeting_b`, `cta_a`) is recorded in `chat_history.log` on the matching `OUT` line.

To compare which variant performs better: filter `chat_history.log` for `OUT` lines with a `variantId`, group by `chatId` to find which variant each conversation got, then cross-reference those `chatId`s/phone numbers against the **Leads** sheet's `Order Status` to see which variant's conversations reached "Completed" more often. Add or edit variants directly in `prompts.js` — no other code changes needed.

## 15. Enabling AI later (optional)

By default `AI_PROVIDER=none` and the bot uses the built-in rule-based Egyptian Arabic sales agent — no API key is required.

To enable an AI provider instead, edit `.env`:

- `AI_PROVIDER=openai` + `OPENAI_API_KEY=...`
- `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...`

**Important: the AI provider only rephrases replies — it never decides what to say.** The rule engine always determines the actual reply (which product to recommend, what price to quote, whether an order is confirmed/cancelled, and what gets logged to the **Leads** tab). When an AI provider is enabled, that rule-based reply is passed to the LLM with instructions to reword it into more natural Egyptian Arabic *without changing any fact in it*. A safety check rejects the AI's rewording (falling back to the original) if it altered any number in the text (e.g. a price). This means:

- Leads are always logged to Google Sheets, whether or not an AI provider is enabled.
- The AI can never recommend a product or quote a price that didn't come from `products.json`/the **Products** tab.
- If the AI call fails, times out, or the key is missing, the bot automatically falls back to the original rule-based reply so it never stops responding.

## 16. Free-form LLM agent (optional, replaces the rule engine)

By default `AGENT_MODE=rules` and the bot behaves exactly as described above (sections
1–15) — a deterministic state machine, optionally rephrased by an AI provider but never
driven by one. Setting `AGENT_MODE=llm` switches to a free-form, conversational agent
(`src/bot/llmAgent.js`) powered by Google Gemini Flash that reasons over the full chat
history instead of matching keywords stage-by-stage — handling direct brand/product
searches, rejections, and chit-chat without needing another manual keyword patch for
every new phrasing.

**Setup** (edit `.env`):
```
AGENT_MODE=llm
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_FALLBACK_ENABLED=true
OPENAI_API_KEY=...   # required for the fallback below
```

**Resilience**: if the Gemini call fails (timeout, HTTP error, malformed response), the
agent automatically retries the same turn against `OPENAI_API_KEY` (gpt-4o-mini) using
the identical structured-output schema, before ever falling back to a static canned
reply — a Gemini outage degrades to a second real LLM, not silence. Set
`GEMINI_FALLBACK_ENABLED=false` to disable this and go straight to the canned reply
instead. `OPENAI_API_KEY` now serves double duty: the legacy rephrase-only step
(`AI_PROVIDER=openai`) and this fallback both use it.

**Strict data boundaries, enforced in code, not just prompted**: every reply is
validated before being sent — any product the model mentions must come from that
turn's real catalog-search candidates (never invented), and any price it states must
match a real candidate's price digit-for-digit (never invented or altered). Order
completion (name + address + alt phone, all confirmed) and human handover are likewise
decided by code from the model's structured output, never trusted as a bare assertion.
A hard turn-counter forces a handover if order collection stalls for 3 turns with no
new field captured, regardless of what the model says.

**Canary rollout**: set `LLM_AGENT_TEST_CHAT_IDS=201xxxxxxxxx,201yyyyyyyyy` (comma-
separated phone numbers, no `@c.us`/`@lid` suffix) to route only those specific real
customers through the LLM agent while `AGENT_MODE` stays `rules` for everyone else —
useful for testing on your own number against live infrastructure before flipping the
global default.

**Local test harness** (no live-WhatsApp risk — never writes to the Leads sheet or
pages the real admin number, even with real API keys configured):
```bash
node scripts/llmAgentHarness.js
```
Type messages and press Enter; state persists turn-to-turn in the same session store
production uses, so you can script a full conversation (product search → order →
confirmation) and inspect the exact `reply`/`logEntry`/`adminNotification` each turn
would have produced.

## 17. Running with PM2 (background operation)

```bash
npm install -g pm2
pm2 start src/index.js --name beauty-hub-bot
pm2 save
pm2 startup
pm2 restart beauty-hub-bot
pm2 logs beauty-hub-bot
pm2 stop beauty-hub-bot
```

## 18. Reconnecting WhatsApp if the session expires

1. Stop the bot (`pm2 stop beauty-hub-bot` or `Ctrl+C`).
2. Delete the session folder: `rm -rf .wwebjs_auth`.
3. Start the bot again (`npm start` or `pm2 restart beauty-hub-bot`).
4. Scan the new QR code shown in the terminal, following the steps in section 5.

## Project structure

```
beauty-hub-october-bot/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── credentials.example.json
├── products.json
├── scripts/
│   └── llmAgentHarness.js       # local test harness for the LLM agent (section 16)
├── src/
│   ├── index.js
│   ├── config.js
│   ├── whatsapp/
│   │   └── client.js
│   ├── bot/
│   │   ├── agent.js             # router: rule engine (default) or llmAgent, by AGENT_MODE
│   │   ├── llmAgent.js          # free-form Gemini/OpenAI-driven agent (section 16)
│   │   ├── llmSystemPrompt.js   # persona + structured-output schema for llmAgent.js
│   │   ├── productSearch.js     # free-text catalog search used by llmAgent.js
│   │   ├── sessionLogHelpers.js # shared log-field/escalation-response helpers
│   │   ├── prompts.js
│   │   ├── orderDetector.js
│   │   ├── faqDetector.js
│   │   ├── escalationDetector.js
│   │   ├── cartRecovery.js
│   │   ├── conversationMemory.js
│   │   └── productMatcher.js
│   ├── services/
│   │   ├── googleSheets.js
│   │   ├── googleSheetsProducts.js
│   │   ├── geminiService.js     # primary LLM provider for llmAgent.js
│   │   ├── openaiService.js     # legacy rephrase + LLM-agent fallback provider
│   │   └── anthropicService.js
│   └── utils/
│       ├── logger.js
│       ├── chatLogger.js
│       ├── chatLock.js
│       └── helpers.js
```
