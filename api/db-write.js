const { createClient } = require('@supabase/supabase-js');

// Разрешённые таблицы и операции — белый список, чтобы прокси нельзя было
// использовать для чего-то за пределами того, что реально нужно приложению
const ALLOWED_TABLES = new Set([
  'projects', 'sections', 'rows', 'photos',
  'categories', 'tags', 'project_tags',
  'row_progress', 'section_collapse_state'
]);
const ALLOWED_OPS = new Set(['insert', 'update', 'upsert', 'delete']);

const supabase = createClient(
  'https://vcsgpauejnqznygdqxyo.supabase.co',
  process.env.SUPABASE_SECRET_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const { table, operation, payload, match, select } = req.body;

    if (!ALLOWED_TABLES.has(table)) {
      return res.status(400).json({ error: 'Недопустимая таблица' });
    }
    if (!ALLOWED_OPS.has(operation)) {
      return res.status(400).json({ error: 'Недопустимая операция' });
    }

    let query = supabase.from(table);

    if (operation === 'insert') {
      query = query.insert(payload);
    } else if (operation === 'upsert') {
      query = query.upsert(payload);
    } else if (operation === 'update') {
      if (!match || typeof match !== 'object' || !Object.keys(match).length) {
        return res.status(400).json({ error: 'Для update нужен match (иначе можно случайно изменить всю таблицу)' });
      }
      query = query.update(payload);
      for (const [key, value] of Object.entries(match)) {
        query = Array.isArray(value) ? query.in(key, value) : query.eq(key, value);
      }
    } else if (operation === 'delete') {
      if (!match || typeof match !== 'object' || !Object.keys(match).length) {
        return res.status(400).json({ error: 'Для delete нужен match (иначе можно случайно удалить всю таблицу)' });
      }
      query = query.delete();
      for (const [key, value] of Object.entries(match)) {
        query = Array.isArray(value) ? query.in(key, value) : query.eq(key, value);
      }
    }

    if (select) {
      query = query.select(select === true ? '*' : select);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ data });

  } catch (err) {
    return res.status(500).json({ error: 'Внутренняя ошибка: ' + err.message });
  }
};
