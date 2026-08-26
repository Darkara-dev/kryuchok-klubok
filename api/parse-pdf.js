const pdfParse = require('pdf-parse');

const SYSTEM_PROMPT = `Ты помощник, который разбирает схемы вязания крючком (на английском или русском языке) в структурированный JSON для приложения-чеклиста.

Правила разбора:
1. Раздели схему на детали (секции) — например "Голова", "Тело", "Нога 1", "Рука 1" и т.д. Если в оригинале написано "make 2" (сделать 2 детали) — создай ДВЕ отдельные секции с номерами (например "Рука 1" и "Рука 2"), с одинаковым содержимым рядов.
2. Внутри каждой детали разбей на отдельные ряды. Если несколько рядов идут подряд с одинаковым описанием (например "14-17. sc all around (18)" — это 4 ряда без изменений), создай ОТДЕЛЬНУЮ строку для каждого ряда, не объединяй их в одну.
3. Переведи вязальные обозначения на русский:
   mgc/magic circle → "ВК" (волшебное кольцо)
   sc → "сбн" (столбик без накида)
   hdc → "псн" (полустолбик с накидом)
   dc → "ссн" (столбик с накидом)
   tc → "сс2н" (столбик с двумя накидами)
   ch → "вп" (воздушная петля)
   inc → "прибавка"
   dec → "убавка"
   Формулируй описание по-русски естественно, например "(2 сбн, прибавка) x6" вместо дословного перевода.
4. Число в скобках в конце ряда (итоговое количество петель) вынеси в отдельное поле total, а не оставляй в тексте описания.
5. Особые указания (когда вставить глазки, что пришить, куда положить маркер и т.п.) вынеси в поле note, а не в основное описание.
6. Если у детали есть общее указание (например "нить А, набивать по ходу вязания") — вынеси в поле meta детали.

Ответь СТРОГО в формате JSON, без markdown-разметки, без пояснений до или после, вот такой структуры:
{
  "sections": [
    {
      "title": "Название детали",
      "meta": "общее примечание к детали или null",
      "rows": [
        { "description": "текст ряда по-русски", "note": "примечание или null", "total": число_или_null }
      ]
    }
  ]
}`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const { pdfUrl } = req.body;
    if (!pdfUrl) {
      return res.status(400).json({ error: 'Ссылка на файл не передана' });
    }

    // --- 1. Скачиваем PDF по ссылке из Supabase Storage ---
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      return res.status(400).json({ error: 'Не удалось скачать файл по ссылке' });
    }
    const arrayBuffer = await pdfResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // --- 2. Достаём текст из PDF ---
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text.trim();

    if (text.length < 200) {
      return res.status(200).json({
        scanned: true,
        message: 'Похоже, это скан или фото без текстового слоя. Такие схемы пока не поддерживаются — этот тип разбора добавим отдельным шагом.'
      });
    }

    // --- 3. Отправляем текст нейронке через OpenRouter ---
    const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        models: [
          'z-ai/glm-5.2:free',
          'minimax/minimax-m3:free',
          'nvidia/nemotron-3-super-120b-a12b:free'
        ],
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, 20000) }
        ],
        temperature: 0.2
      })
    });

    if (!orResponse.ok) {
      const errText = await orResponse.text();
      return res.status(502).json({ error: 'Ошибка нейронки: ' + errText });
    }

    const orData = await orResponse.json();
    const rawContent = orData.choices?.[0]?.message?.content || '';

    // --- 4. Достаём JSON из ответа ---
    let cleaned = rawContent.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'Не удалось разобрать ответ нейронки', raw: rawContent });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'Внутренняя ошибка: ' + err.message });
  }
};
