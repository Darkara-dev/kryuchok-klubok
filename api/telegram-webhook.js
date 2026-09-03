const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = 'https://kryuchok-klubok.vercel.app';

const WELCOME_TEXT = `🧶 <b>Привет! Я — Крючок и клубок</b>

Твой личный помощник для вязания крючком 🪡

Вот что я умею:

📚 <b>Каталог схем</b> — все проекты разложены по категориям и подкатегориям, легко найти нужное

📄 <b>Разбираю PDF-схемы сама</b> — загружаешь файл, а я раскладываю его на детали и ряды, переведённые на русский

✅ <b>Чек-лист рядов</b> — отмечай галочками, что уже связано; прогресс у каждого свой, не перепутается

📷 <b>Фото готовых работ</b> — сохраняй снимки прямо в проект

🔍 <b>Поиск</b> — по тегам и названию, если проектов накопилось много

✏️ <b>Всё редактируется</b> — можно поправить или удалить деталь, ряд или сам проект в любой момент

Готова начать? Жми кнопку ниже 👇`;

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🧶 Открыть приложение', web_app: { url: APP_URL } }
        ]]
      }
    })
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true }); // Telegram иногда проверяет доступность GET-запросом
  }

  try {
    const update = req.body;
    const message = update.message;

    if (message && message.chat && message.chat.id) {
      // На /start — полное приветствие. На любое другое сообщение — просто кнопка открытия,
      // чтобы бот не выглядел "немым", если кто-то напишет что-то ещё
      await sendMessage(message.chat.id, WELCOME_TEXT);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    // Telegram не должен получать ошибку 500 — иначе будет считать вебхук нерабочим
    // и повторять попытки; логируем в консоль Vercel, но клиенту отвечаем ok
    console.error('Telegram webhook error:', err.message);
    return res.status(200).json({ ok: true });
  }
};
