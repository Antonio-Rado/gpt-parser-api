// api/gptParser.js
import fetch from "node-fetch";

/**
 * Serverless API (Vercel) — прокси к OpenAI Responses API
 * POST /api/gptParser
 * Body: { mode: "...", text: string, useSearch?: boolean }
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
    let effectiveUseSearch = useSearch;

    // ========== РЕЖИМЫ ==========
    if (mode === "Продукт") {
      systemPrompt =
        "Ты — парсер продуктов питания. Используй интернет-поиск при необходимости. " +
        "Отвечай строго одним JSON-объектом. " +
        "{\"name\": string, \"brand\": string|null, \"grams\": number|null, \"unit\": \"г\"|\"ml\"|null, " +
        "\"calories\": number|null, \"proteinGrams\": number|null, \"fatGrams\": number|null, \"carbGrams\": number|null}.";
    }

    else if (mode === "Рецепт") {
      systemPrompt =
        "Ты — парсер рецептов. Пользователь вводит название блюда и массу. " +
        "Разбей блюдо на ингредиенты с реалистичными массами. " +
        "Отвечай строго JSON: { \"recipe\": string, \"totalGrams\": number, \"ingredients\": [ ... ] }";
    }

    else if (mode === "Прием пищи") {
      systemPrompt =
        "Ты — парсер приёмов пищи. Верни список продуктов с массами, калориями и БЖУ, " +
        "а также totals. Строгий JSON: { mealName, items[], totals }.";
    }

   else if (mode === "Штрихкод") {
  systemPrompt =
    "Ты — парсер продуктов питания. Используй только интернет-поиск по штрихкоду. " +
    "Сначала ищи продукт по штрихкоду. " +
    "Если штрихкод даёт только название и бренд, но нет КБЖУ, тогда выполни поиск на сайте 'www.fatsecret.ru' по названию и найди КБЖУ на 100 г продукта. " +
    "Если продукт не найден, искать на других сайтах. " +
    "Если калории совпадают с 'калории = белок*4 + жир*9 + углеводы*4 в пределах 3%', то берем это значение, если не совпадает, то ищи далее, пока не совпадет. 
    "Если совпадающего варианта не найдется, тогда взять среднее значение БЖУ найденных результатов, и чтобы калории = белок*4 + жир*9 + углеводы*4 в пределах 3% " +
    "Возвращай ТОЛЬКО один JSON-объект вида: " +
    "{\"name\": string, \"brand\": string|null, \"grams\": number|null, " +
    "\"unit\": \"г\"|\"ml\"|null, \"calories\": number|null, " +
    "\"proteinGrams\": number|null, \"fatGrams\": number|null, \"carbGrams\": number|null}. " +
    "Если продукт не найден вообще, либо найдено только название а КБЖУ не найдено — верни {\"notFound\": true}. " +
    "Без текста вокруг, без комментариев.";
  effectiveUseSearch = true;
}


    else {
      return res.status(400).json({ error: "Неизвестный режим: " + mode });
    }

    // ========== PAYLOAD ДЛЯ OPENAI ==========
    const payload = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ],
      temperature: 0.2,
      max_output_tokens: 900
    };

    if (effectiveUseSearch) {
      payload.tools = [{ type: "web_search_preview" }];
    }

    // ========== ЗАПРОС К OPENAI ==========
    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json();

    // ========== ИЗВЛЕЧЕНИЕ ТЕКСТА ==========
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

    if (aggregatedText.startsWith("```")) {
      aggregatedText = aggregatedText
        .replace(/```[a-z]*\n?/gi, "")
        .replace(/```$/g, "")
        .trim();
    }

    const first = aggregatedText.indexOf("{");
    const last = aggregatedText.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      return res.status(500).json({
        error: "Ответ не содержит валидного JSON",
        raw: aggregatedText,
        data
      });
    }
    const jsonText = aggregatedText.substring(first, last + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return res.status(500).json({
        error: "Ошибка парсинга JSON",
        raw: aggregatedText,
        jsonText
      });
    }

    // ========== ДОП. ОБРАБОТКА ДЛЯ "Прием пищи" ==========
    if (mode === "Прием пищи" && parsed && Array.isArray(parsed.items)) {
      const sum = parsed.items.reduce(
        (acc, it) => {
          acc.grams += Number(it.grams || 0);
          acc.calories += Number(it.calories || 0);
          acc.proteinGrams += Number(it.proteinGrams || 0);
          acc.fatGrams += Number(it.fatGrams || 0);
          acc.carbGrams += Number(it.carbGrams || 0);
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
