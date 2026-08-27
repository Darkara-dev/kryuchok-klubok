const pdfParse = require('pdf-parse');
const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');

const SYSTEM_PROMPT = `Ты помощник, который разбирает схемы вязания крючком (на английском или русском языке) в структурированный JSON для приложения-чеклиста.

Правила разбора:
1. Раздели схему на детали (секции) — например "Голова", "Тело", "Нога 1", "Рука 1" и т.д. Если в оригинале указано, что нужно связать НЕСКОЛЬКО одинаковых копий детали — в любой формулировке ("make 2", "create 5", "×3", "8 штук", "(make 2)", "sc x2" в контексте количества деталей и т.п.) — создай ОТДЕЛЬНУЮ пронумерованную секцию для КАЖДОЙ копии с одинаковым содержимым рядов (например для "create 5" — секции "Название 1 из 5", "Название 2 из 5", ... "Название 5 из 5"). Не объединяй копии в одну секцию с общим количеством в примечании — каждая копия должна быть отдельным пунктом в списке деталей, который можно отдельно отмечать по ходу вязания.
2. Внутри детали ряды идут по порядку. Если НЕСКОЛЬКО РЯДОВ ПОДРЯД полностью одинаковы по описанию (например "14-17. sc all around (18)" — это 4 одинаковых ряда, или "8-15 rows (8 rounds): 42 sc (42)" — 8 одинаковых рядов) — НЕ выписывай их как отдельные объекты по одному. Вместо этого укажи ОДИН объект ряда с полем "repeat", равным количеству повторов (например repeat: 4). Поле "description" должно содержать ТОЛЬКО само вязальное действие (например "сбн по кругу") — категорически НЕ включай туда номера рядов, диапазоны рядов ("14-17.", "ряды 8-15") или слово "повторить X раз" — вся эта информация уходит только в поле "repeat", а не в текст. Это касается только ПОЛНОСТЬЮ одинаковых подряд идущих рядов — если ряды хоть чем-то отличаются (числом петель, деталями), они остаются отдельными объектами.
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

7. ВАЖНО: разбери схему ПОЛНОСТЬЮ, от первой до последней детали, включая мелкие и короткие детали (пятнышки, украшения, маленькие элементы декора и т.п.) — не пропускай и не сокращай ни одну часть исходного текста, даже если деталей много.

Ответь СТРОГО в формате JSON, без markdown-разметки, без пояснений до или после, вот такой структуры:
{
  "sections": [
    {
      "title": "Название детали",
      "meta": "общее примечание к детали или null",
      "rows": [
        { "description": "текст ряда по-русски", "note": "примечание или null", "total": число_или_null, "repeat": число_повторов_или_не_указывать }
      ]
    }
  ]
}`;

const zlib = require('zlib');
const jpeg = require('jpeg-js');

// --- Извлекаем лучшую обложку из PDF (для карточки проекта) ---
// Логика:
//  1. Сначала ищем встроенные JPEG-картинки (DCTDecode), включая случай, когда JPEG
//     дополнительно "обёрнут" в FlateDecode (двойное сжатие — так делают некоторые
//     конструкторы PDF вроде Canva)
//  2. Если JPEG не нашлось — ищем "сырые" несжатые картинки (несколько разных
//     кодировок potoка: FlateDecode, часто вместе с ASCII85Decode) и сами кодируем
//     их в JPEG — так делают некоторые генераторы PDF (например экспорт из Word/Docs)
//  3. Пропускаем картинки, чьи пропорции совпадают с пропорциями самой страницы —
//     это почти наверняка декоративный фон на всю страницу, а не фото изделия
//  4. Из оставшихся берём самую крупную по площади — обычно это и есть основное фото
function getFilterList(filter) {
  if (!filter) return [];
  if (filter.constructor && filter.constructor.name === 'PDFName') return [filter.toString()];
  if (filter.array) return filter.array.map(f => f.toString());
  return [];
}

function decodeToJpegBytes(rawContents, filters) {
  let data = Buffer.from(rawContents);
  for (const f of filters) {
    if (f === '/FlateDecode') {
      data = zlib.inflateSync(data);
    } else if (f === '/DCTDecode') {
      break; // дальше идут уже сырые байты JPEG — то, что нужно
    }
  }
  return data;
}

// Adobe-вариант ASCII85 (используется в PDF), в Node нет встроенной поддержки
function decodeAscii85(buf) {
  let str = buf.toString('latin1').replace(/<~|~>/g, '').replace(/\s+/g, '');
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    let chunk = str.slice(i, i + 5);
    const chunkLen = chunk.length;
    while (chunk.length < 5) chunk += 'u';
    let value = 0;
    for (let j = 0; j < 5; j++) value = value * 85 + (chunk.charCodeAt(j) - 33);
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...bytes.slice(0, chunkLen - 1));
    i += 5;
  }
  return Buffer.from(out);
}

// Раскодировываем "сырую" картинку (не JPEG) до плоских пикселей и сами упаковываем в JPEG
function decodeRawImageToJpeg(rawContents, filters, width, height, colorSpace, bitsPerComponent) {
  let data = Buffer.from(rawContents);
  for (const f of filters) {
    if (f === '/ASCII85Decode') data = decodeAscii85(data);
    else if (f === '/FlateDecode') data = zlib.inflateSync(data);
    else if (f === '/ASCIIHexDecode') data = Buffer.from(data.toString('latin1').replace(/>/g, ''), 'hex');
    else return null; // незнакомый фильтр (например реальный DCTDecode, JPXDecode) — не наш случай
  }

  if (bitsPerComponent !== 8) return null; // поддерживаем только самый частый случай — 8 бит на канал

  let channels;
  if (colorSpace === '/DeviceRGB') channels = 3;
  else if (colorSpace === '/DeviceGray') channels = 1;
  else if (colorSpace === '/DeviceCMYK') channels = 4;
  else return null;

  const expected = width * height * channels;
  if (data.length < expected) return null;

  const rgba = Buffer.alloc(width * height * 4);
  for (let px = 0; px < width * height; px++) {
    const srcOff = px * channels;
    const dstOff = px * 4;
    if (channels === 3) {
      rgba[dstOff] = data[srcOff];
      rgba[dstOff + 1] = data[srcOff + 1];
      rgba[dstOff + 2] = data[srcOff + 2];
    } else if (channels === 1) {
      rgba[dstOff] = rgba[dstOff + 1] = rgba[dstOff + 2] = data[srcOff];
    } else if (channels === 4) {
      // грубое приближение CMYK -> RGB
      const c = data[srcOff] / 255, m = data[srcOff + 1] / 255, y = data[srcOff + 2] / 255, k = data[srcOff + 3] / 255;
      rgba[dstOff] = 255 * (1 - c) * (1 - k);
      rgba[dstOff + 1] = 255 * (1 - m) * (1 - k);
      rgba[dstOff + 2] = 255 * (1 - y) * (1 - k);
    }
    rgba[dstOff + 3] = 255;
  }

  const encoded = jpeg.encode({ data: rgba, width, height }, 85);
  return Buffer.from(encoded.data);
}

async function extractBestCover(pdfBytes) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const firstPage = pdfDoc.getPage(0);
    const { width: pageW, height: pageH } = firstPage.getSize();
    const pageRatio = pageW / pageH;

    const indirectObjects = pdfDoc.context.enumerateIndirectObjects();
    const jpegCandidates = [];
    const rawCandidates = [];

    for (const [, obj] of indirectObjects) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      const isImage = subtype && subtype.toString() === '/Image';
      if (!isImage) continue;

      const filters = getFilterList(dict.get(PDFName.of('Filter')));
      const widthObj = dict.get(PDFName.of('Width'));
      const heightObj = dict.get(PDFName.of('Height'));
      const w = widthObj ? Number(widthObj.numberValue ?? widthObj.value ?? widthObj.toString()) : 0;
      const h = heightObj ? Number(heightObj.numberValue ?? heightObj.value ?? heightObj.toString()) : 0;
      if (!w || !h) continue;

      const ratio = w / h;
      const looksLikePageBackground = Math.abs(ratio - pageRatio) < 0.08;
      const area = w * h;

      if (filters.includes('/DCTDecode')) {
        jpegCandidates.push({ obj, filters, area, looksLikePageBackground });
      } else {
        const csObj = dict.get(PDFName.of('ColorSpace'));
        const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
        const colorSpace = csObj ? csObj.toString() : null;
        const bpc = bpcObj ? Number(bpcObj.numberValue ?? bpcObj.value ?? bpcObj.toString()) : null;
        rawCandidates.push({ obj, filters, area, looksLikePageBackground, w, h, colorSpace, bpc });
      }
    }

    // Сначала пробуем найти нормальный JPEG
    if (jpegCandidates.length) {
      const nonBg = jpegCandidates.filter(c => !c.looksLikePageBackground);
      const pool = nonBg.length ? nonBg : jpegCandidates;
      pool.sort((a, b) => b.area - a.area);
      return decodeToJpegBytes(pool[0].obj.contents, pool[0].filters);
    }

    // JPEG не нашли — пробуем "сырые" картинки, перебирая от самой крупной,
    // пока одна из них успешно не раскодируется
    if (rawCandidates.length) {
      const nonBg = rawCandidates.filter(c => !c.looksLikePageBackground);
      const pool = (nonBg.length ? nonBg : rawCandidates).slice().sort((a, b) => b.area - a.area);
      for (const cand of pool) {
        const result = decodeRawImageToJpeg(cand.obj.contents, cand.filters, cand.w, cand.h, cand.colorSpace, cand.bpc);
        if (result) return result;
      }
    }

    return null;
  } catch (e) {
    return null; // если PDF повреждён/зашифрован для pdf-lib — просто не даём обложку, не валим весь запрос
  }
}

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

    // --- 3. Пробуем достать картинку-обложку (не блокирует основной разбор при неудаче) ---
    const coverBuffer = await extractBestCover(buffer);
    const coverImageBase64 = coverBuffer ? coverBuffer.toString('base64') : null;

    // --- 4. Отправляем текст нейронке через OpenRouter ---
    // Перебираем модели вручную со своим тайм-аутом на каждую (15 сек), чтобы одна
    // медленная бесплатная модель не съедала весь общий лимит времени функции (60 сек)
    const MODELS = [
      'z-ai/glm-5.2:free',
      'minimax/minimax-m3:free',
      'nvidia/nemotron-3-super-120b-a12b:free'
    ];
    const PER_MODEL_TIMEOUT_MS = 15000;

    async function callModel(model) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PER_MODEL_TIMEOUT_MS);
      try {
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: text.slice(0, 20000) }
            ],
            temperature: 0.2,
            max_tokens: 16000
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
      } catch (e) {
        clearTimeout(timeoutId);
        throw e;
      }
    }

    let orData = null;
    let lastError = null;
    for (const model of MODELS) {
      try {
        orData = await callModel(model);
        break;
      } catch (e) {
        lastError = e;
        continue; // пробуем следующую модель
      }
    }

    if (!orData) {
      return res.status(504).json({
        error: 'Все бесплатные модели сейчас перегружены или не ответили вовремя. Попробуй ещё раз через минуту.'
      });
    }

    const rawContent = orData.choices?.[0]?.message?.content || '';

    // --- 5. Достаём JSON из ответа ---
    let cleaned = rawContent.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: 'Не удалось разобрать ответ нейронки', raw: rawContent });
    }

    // Подстраховка: если нейронка всё же оставила в тексте ряда обрывок вида
    // "14-17." или "14." — вычищаем его, даже если инструкция была нарушена
    if (parsed.sections) {
      parsed.sections.forEach(sec => {
        (sec.rows || []).forEach(r => {
          if (r.description) {
            r.description = r.description.replace(/^\s*\d+\s*(-\s*\d+)?\.\s*/, '').trim();
          }
        });
      });
    }

    parsed.coverImageBase64 = coverImageBase64;

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: 'Внутренняя ошибка: ' + err.message });
  }
};
