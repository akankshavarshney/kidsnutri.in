// Cloudflare Pages Function — POST /api/parse-meal
// Takes free text like "2 rotis, dal, and a banana" and matches it
// against KidsNutri's existing FOOD_DB names using Claude.
//
// SETUP REQUIRED:
// 1. In Cloudflare Pages → your kidsnutri project → Settings → Environment variables
//    add a variable named ANTHROPIC_API_KEY with your Anthropic API key as the value
//    (get one at console.anthropic.com — keep it secret, never put it in frontend code)
// 2. This file must live at: functions/api/parse-meal.js in your project root
//    (Cloudflare Pages auto-detects the /functions folder on deploy — no extra config needed)

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { text, foodNames, currentHour } = body;

    if (!text || !foodNames || !Array.isArray(foodNames)) {
      return new Response(JSON.stringify({ error: 'Missing text or foodNames' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Guess the meal slot from time of day, same buckets the app already uses
    const hour = typeof currentHour === 'number' ? currentHour : new Date().getHours();
    const mealGuess =
      hour < 10 ? 'breakfast' :
      hour < 12 ? 'morning_snack' :
      hour < 15 ? 'lunch' :
      hour < 18 ? 'evening_snack' :
      hour < 21 ? 'dinner' : 'bedtime';

    const systemPrompt = `You are a meal-logging assistant for a kids' nutrition app. The parent describes what their child ate in free text (English or Hinglish). Identify each distinct food item, match it to the CLOSEST item in the provided food list, and estimate quantity.

Rules:
- ONLY use food names EXACTLY as they appear in the provided list. Never invent a name.
- If something genuinely has no reasonable match, put a short description of it in "unmatched" instead of guessing.
- If the parent gives a number ("2 rotis"), use it as qty. If no number given, default qty to 1.
- Output ONLY valid JSON, nothing else, in exactly this shape:
{"items": [{"name": "<exact name from list>", "qty": <number>}], "unmatched": ["<text>"]}`;

    const userPrompt = `Food list (choose only from these names):\n${foodNames.join(', ')}\n\nParent's description: "${text}"`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(JSON.stringify({ error: 'AI request failed', detail: errText }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await resp.json();
    const raw = (data.content && data.content[0] && data.content[0].text) || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = { items: [], unmatched: [text] };
    }

    // Safety net: only accept items whose name is an exact match in the real list,
    // so nutrition calculation downstream never breaks on a hallucinated name.
    const validNames = new Set(foodNames);
    parsed.items = (parsed.items || []).filter(i => i && validNames.has(i.name));
    parsed.unmatched = parsed.unmatched || [];
    parsed.suggestedMeal = mealGuess;

    return new Response(JSON.stringify(parsed), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
