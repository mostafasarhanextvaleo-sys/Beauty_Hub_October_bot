const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');
const { resilientFetch } = require('../utils/resilientFetch');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// gpt-4o-mini accepts image inputs (same tier already used for the rest of
// the LLM agent — see openaiService.js) — no need for a separate, pricier
// vision-only model just for this.
const VISION_MODEL = 'gpt-4o-mini';

// Deliberately produces a neutral, factual DESCRIPTION only — never advice,
// a diagnosis, or a product recommendation. That reasoning stays entirely
// inside llmAgent.js's normal turn (guardrails: SPECIALIST_REFERRAL, sheet-
// only price/product grounding, etc.), which only ever sees this as a plain
// text string appended to the customer's message — see whatsapp/client.js.
// Keeping the two steps separate means a vision-model quirk (over-confident
// medical language, inventing a product name) can never bypass those
// guardrails the way it would if this were allowed to reply to the customer
// directly.
const VISION_SYSTEM_PROMPT =
  'أنت أداة وصف صور داخلية لمتجر مستحضرات تجميل مصري، مش بتتكلمي مع العميلة مباشرة. ' +
  'مهمتك الوحيدة: وصف محتوى الصورة اللي بعتتها العميلة بشكل موضوعي ومختصر (٢-٣ جمل بالعربي المصري) ' +
  'عشان موظفة المبيعات (سارة) تقدر تكمل المحادثة بناءً عليه. ' +
  'لو الصورة فيها بشرة أو مشكلة جلدية (حبوب، احمرار، بقع، تجاعيد، هالات...) صفي اللي شايفاه بحيادية ' +
  'من غير تشخيص طبي أو اسم مرض. لو الصورة فيها منتج أو ليبل منتج، اكتبي اسم البراند/المنتج والنص المكتوب لو واضح. ' +
  'لو الصورة روشتة أو عبوة دواء، اذكري اسم الدواء/المكون لو واضح من غير أي تعليق. ' +
  'ممنوع تماماً إنك تقترحي منتج أو تديني سعر أو نصيحة علاجية — ده مش دورك خالص، فقط وصفي اللي في الصورة.';

// Never throws — returns null on any failure (missing key, network error,
// non-image content, API outage) so the caller can fall back to the existing
// "couldn't see this" behavior exactly as it did before this feature existed.
async function analyzeImage({ base64Data, mimeType, caption }) {
  if (!config.openaiApiKey) {
    logger.warn('OPENAI_API_KEY missing — cannot analyze incoming image.');
    return null;
  }
  if (!base64Data) return null;

  try {
    const userContent = [
      {
        type: 'text',
        text: caption ? `تعليق العميلة على الصورة: ${caption}` : 'وصفيلي الصورة دي.',
      },
      {
        type: 'image_url',
        image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64Data}` },
      },
    ];

    const response = await resilientFetch(
      'openai-vision',
      config.openaiChatConcurrency,
      () =>
        fetch(OPENAI_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.openaiApiKey}`,
          },
          body: JSON.stringify({
            model: VISION_MODEL,
            messages: [
              { role: 'system', content: VISION_SYSTEM_PROMPT },
              { role: 'user', content: userContent },
            ],
            temperature: 0.2,
            max_tokens: 220,
          }),
        }),
      { timeoutMs: config.openaiTimeoutMs, label: 'OpenAI /chat/completions (analyzeImage)' }
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`OpenAI Vision API error: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error('Failed to call OpenAI Vision API.', err);
    return null;
  }
}

module.exports = { analyzeImage };
