// api/gptParser.js
import fetch from "node-fetch";

/**
 * Serverless API (Vercel) — прокси к OpenAI Responses API
 * POST /api/gptParser
 * Body: { mode: "Продукт"|"Рецепт"|"Прием пищи", text: string, useSearch?: boolean }
 */
export default async function handler(req, res) {
  // --- CORS (на случай Flutter Web)
  const allowOrigins = process.env.ALLOW_ORIGINS || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigins);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { mode, text, useSearch = true } = req.body || {};
    if (!mode || !text) {
      return res.status(400).json({ error: "Поля mode и text обязательны" });
    }

    let systemPrompt = "";
    if (mode === "Продукт") {
      systemPrompt =
        "Ты — парсер продуктов питания. Используй интернет-поиск при необходимости. " +
        "Отвечай строго одним JSON-объектом, без текста вокруг. " +
        "Формат: {\"name\": string, \"brand\": string|null, \"grams\": number|null, " +
        "\"unit\": \"г\"|\"ml\"|null, \"calories\": number|null, " +
        "\"proteinGrams\": number|null, \"fatGrams\": number|null, \"carbGrams\": number|null}. " +
        "Если пользователь указал массу, БЖУ и калории должны соответствовать этой массе.";
    } else if (mode === "Рецепт") {
      systemPrompt =
        "Ты — парсер рецептов. Пользователь вводит название блюда и массу (общую). " +
        "Разбей блюдо на ингредиенты в реалистичных пропорциях, чтобы сумма масс равнялась общей. " +
        "Для каждого ингредиента укажи калории и БЖУ на его массу (не на 100 г). " +
        "Отвечай строго одним JSON-объектом. Формат: " +
        "{ \"recipe\": string, \"totalGrams\": number, \"ingredients\": [ " +
        "{ \"name\": string, \"brand\": string|null, \"grams\": number, \"unit\": \"г\"|\"ml\", " +
        "\"calories\": number, \"proteinGrams\": number, \"fatGrams\": number, \"carbGrams\": number } ] }";
    } else if (mode === "Прием пищи") {
      systemPrompt =
        "Ты — парсер приёмов пищи (набор/комбо). Пользователь перечисляет продукты/блюда, " +
        "массы могут быть заданы частично или совсем не заданы. Верни список с массами " +
        "(укажи типичные, если не заданы), калориями и БЖУ на эту массу, а также общие итоги. " +
        "Отвечай строго JSON. Формат: " +
        "{ \"mealName\": string, \"items\": [ " +
        "{ \"name\": string, \"brand\": string|null, \"grams\": number, \"unit\": \"г\"|\"ml\", " +
        "\"calories\": number, \"proteinGrams\": number, \"fatGrams\": number, \"carbGrams\": number } ], " +
        "\"totals\": {\"grams\": number, \"calories\": number, \"proteinGrams\": number, \"fatGrams\": number, \"carbGrams\": number} }";
    } else {
      return res.status(400).json({ error: "Неизвестный режим: " + mode });
    }

    const payload = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ],
      temperature: 0,
      max_output_tokens: 900
    };

    // По желанию включаем веб-поиск (не используем JSON-mode одновременно)
    if (useSearch) {
      payload.tools = [{ type: "web_search_preview" }];
    }

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json();

    // Извлекаем текст из Responses API
    let aggregatedText = "";
    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (typeof part.text === "string") aggregatedText += part.text;
          }
        }
      }
    }
    aggregatedText = (aggregatedText || "").trim();

    // Чистим возможные ```json / ```
    if (aggregatedText.startsWith("```")) {
      aggregatedText = aggregatedText
        .replace(/```[a-z]*\n?/gi, "")
        .replace(/```$/g, "")
        .trim();
    }

    // Вырезаем первый JSON-блок
    const first = aggregatedText.indexOf("{");
    const last = aggregatedText.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      return res.status(500).json({ error: "Ответ не содержит валидного JSON", raw: aggregatedText, data });
    }
    const jsonText = aggregatedText.substring(first, last + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({ error: "Ошибка парсинга JSON", raw: aggregatedText, jsonText });
    }

    // Для "Прием пищи" — если totals не пришёл, посчитаем сами
    if (mode === "Прием пищи" && parsed && Array.isArray(parsed.items)) {
      const sum = parsed.items.reduce(
        (acc, it) => {
          const g = Number(it.grams || 0);
          const cal = Number(it.calories || 0);
          const p = Number(it.proteinGrams || 0);
          const f = Number(it.fatGrams || 0);
          const c = Number(it.carbGrams || 0);
          acc.grams += g;
          acc.calories += cal;
          acc.proteinGrams += p;
          acc.fatGrams += f;
          acc.carbGrams += c;
          return acc;
        },
        { grams: 0, calories: 0, proteinGrams: 0, fatGrams: 0, carbGrams: 0 }
      );
      parsed.totals = parsed.totals || sum;
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
