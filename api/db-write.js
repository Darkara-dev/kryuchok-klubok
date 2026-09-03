const { createClient } = require('@supabase/supabase-js');

// Разрешённые таблицы и операции — белый список, чтобы прокси нельзя было
// использовать для чего-то за пределами того, что реально нужно приложению
const ALLOWED_TABLES = new Set([
  'projects', 'sections', 'rows', 'photos',
  'categories', 'tags', 'project_tags',
  'row_progress', 'section_collapse_state'
]);
const ALLOWED_OPS = new Set(['insert', 'update', 'upsert', 'delete']);

// Удаление проекта и всего, что внутри него (детали, ряды), разрешено только
// автору проекта или админу — проверяем это здесь, а не только в интерфейсе,
// иначе запрет можно было бы обойти прямым запросом к этому же API
const OWNERSHIP_PROTECTED_TABLES = new Set(['projects', 'sections', 'rows']);
const ADMIN_USER_ID = '174867272';

const supabase = createClient(
  'https://vcsgpauejnqznygdqxyo.supabase.co',
  process.env.SUPABASE_SECRET_KEY
);

// Находит telegram_user_id автора проекта, к которому относится удаляемая запись
async function resolveProjectOwner(table, match) {
  if (table === 'projects') {
    const { data } = await supabase.from('projects').select('created_by').eq('id', match.id).single();
    return data ? data.created_by : null;
  }
  if (table === 'sections') {
    const { data: sec } = await supabase.from('sections').select('project_id').eq('id', match.id).single();
    if (!sec) return null;
    const { data: proj } = await supabase.from('projects').select('created_by').eq('id', sec.project_id).single();
    return proj ? proj.created_by : null;
  }
  if (table === 'rows') {
    const { data: row } = await supabase.from('rows').select('section_id').eq('id', match.id).single();
    if (!row) return null;
    const { data: sec } = await supabase.from('sections').select('project_id').eq('id', row.section_id).single();
    if (!sec) return null;
    const { data: proj } = await supabase.from('projects').select('created_by').eq('id', sec.project_id).single();
    return proj ? proj.created_by : null;
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  try {
    const { table, operation, payload, match, select, requesterId } = req.body;

    if (!ALLOWED_TABLES.has(table)) {
      return res.status(400).json({ error: 'Недопустимая таблица' });
    }
    if (!ALLOWED_OPS.has(operation)) {
      return res.status(400).json({ error: 'Недопустимая операция' });
    }

    // Проверка прав на удаление проекта/детали/ряда
    if (operation === 'delete' && OWNERSHIP_PROTECTED_TABLES.has(table)) {
      if (!requesterId) {
        return res.status(400).json({ error: 'Не удалось определить пользователя' });
      }
      if (requesterId !== ADMIN_USER_ID) {
        if (!match || !match.id) {
          return res.status(400).json({ error: 'Не указано, что удалять' });
        }
        const ownerId = await resolveProjectOwner(table, match);
        if (ownerId !== requesterId) {
          return res.status(403).json({ error: 'Удалить может только автор проекта или администратор' });
        }
      }
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
