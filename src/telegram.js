import crypto from 'node:crypto';
import { getUser, setChatId, getAllUsers, markInitialized, markNotified } from './store.js';
import { fetchListings, sourceStatus } from './provider.js';
import { scoreListings } from './scoring.js';
import { normalizeDirectAvitoUrl } from './listing-url.js';

let bot = null;
let lastProviderError = null;

export function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: 'missing' };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = Number(params.get('auth_date'));
    if (!hash || !Number.isFinite(authDate)) return { ok: false, reason: 'malformed' };
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const got = Buffer.from(hash, 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'signature' };
    const maxAge = Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400);
    if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > maxAge) return { ok: false, reason: 'expired' };
    const user = params.get('user');
    if (!user) return { ok: false, reason: 'no-user' };
    const parsedUser = JSON.parse(user);
    if (!parsedUser.id) return { ok: false, reason: 'no-id' };
    return { ok: true, user: parsedUser };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function escapeMarkdown(text = '') {
  return String(text).replace(/([_*`[\]])/g, '\\$1');
}

function dealMessage(item) {
  const price = Number(item.price).toLocaleString('ru-RU');
  const market = item.marketPrice ? Number(item.marketPrice).toLocaleString('ru-RU') : 'н/д';
  const discount = item.discountPct === null ? 'н/д' : `${item.discountPct}%`;
  const warnings = item.riskNotes?.length ? `\n⚠️ ${item.riskNotes.slice(0, 2).join('; ')}` : '';
  const directUrl = normalizeDirectAvitoUrl(item.url);
  const linkLine = directUrl ? `[Открыть объявление](${directUrl})` : '_Источник не вернул прямую ссылку на объявление._';
  return `🔥 *Потенциально выгодный iPhone*\n\n*${escapeMarkdown(item.title)}*\nЦена: *${price} ₽*\nОриентир рынка: ${market} ₽\nНиже ориентира: *${discount}*\nГород: ${escapeMarkdown(item.location || 'не указан')}${warnings}\n\n${linkLine}\n\n_Проверь устройство лично: цена не гарантирует исправность._`;
}

async function telegramApi(method, body) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN не задан');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram API HTTP ${response.status}`);
  return result.result;
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.chat?.id || !msg?.from?.id || typeof msg.text !== 'string') return;
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  if (/^\/start(?:@\w+)?(?:\s+.*)?$/.test(msg.text.trim())) {
    await setChatId(userId, chatId);
    const appUrl = process.env.WEBAPP_URL;
    if (appUrl) {
      await telegramApi('sendMessage', {
        chat_id: chatId,
        text: 'Готов искать выгодные iPhone на Avito. Открой мини-приложение и настрой фильтры.',
        reply_markup: { inline_keyboard: [[{ text: '🍏 Открыть iPhone Radar', web_app: { url: appUrl } }]] }
      });
    } else {
      await telegramApi('sendMessage', {
        chat_id: chatId,
        text: 'Бот работает. Чтобы открыть Mini App, укажи публичный HTTPS-адрес в WEBAPP_URL и перезапусти сервер.'
      });
    }
  } else if (/^\/status(?:@\w+)?$/.test(msg.text.trim())) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: lastProviderError ? `Источник объявлений недоступен: ${lastProviderError}` : 'Последняя проверка источника не сообщала об ошибках.'
    });
  }
}

async function pollingLoop() {
  let offset = 0;
  while (bot) {
    try {
      const updates = await telegramApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        try { await handleUpdate(update); }
        catch (error) { console.error('Не удалось обработать сообщение Telegram:', error.message); }
      }
    } catch (error) {
      console.error('Telegram polling error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

export function startTelegramBot() {
  if (!process.env.BOT_TOKEN) {
    console.warn('BOT_TOKEN не задан: Telegram-команды и push-уведомления выключены.');
    return null;
  }
  bot = { sendMessage: (chatId, text, options = {}) => telegramApi('sendMessage', { chat_id: chatId, text, ...options }) };
  void pollingLoop();
  return bot;
}

export function getBot() { return bot; }
export function setProviderError(error) { lastProviderError = error ? String(error).slice(0, 300) : null; }

export async function pollAndNotify() {
  let fetched;
  try {
    fetched = await fetchListings({ force: true });
    const status = sourceStatus();
    if (status.mode !== 'live') {
      setProviderError(status.note);
      return;
    }
    setProviderError(null);
  } catch (error) {
    setProviderError(error.message);
    console.error('Ошибка обновления объявлений:', error.message);
    return;
  }
  if (!bot) return;
  const allUsers = await getAllUsers();
  for (const entry of allUsers) {
    const user = getUser(entry.id);
    const scored = scoreListings(fetched.listings, user.settings);
    const ids = scored.map(item => item.id);
    if (!user.initialized) {
      await markInitialized(entry.id, ids);
      continue;
    }
    if (!user.chatId || !user.settings.notificationsEnabled) continue;
    const alreadySent = new Set(user.notifiedIds || []);
    const newDeals = scored.filter(item => item.isDeal && normalizeDirectAvitoUrl(item.url) && !alreadySent.has(String(item.id)));
    for (const item of newDeals.slice(0, 15)) {
      try {
        await bot.sendMessage(user.chatId, dealMessage(item), {
          parse_mode: 'Markdown',
          disable_web_page_preview: false
        });
        await markNotified(entry.id, [item.id]);
      } catch (error) {
        console.error(`Не удалось отправить уведомление пользователю ${entry.id}:`, error.message);
      }
    }
  }
}
