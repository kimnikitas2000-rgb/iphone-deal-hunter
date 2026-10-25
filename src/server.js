import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');

async function loadEnvFile() {
  try {
    const text = await fs.readFile(path.join(projectDir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await loadEnvFile();

const [{ initStore, getUser, updateSettings, DEFAULT_SETTINGS }, { fetchListings, sourceStatus, getMarketBenchmarks }, { scoreListings }, { validateTelegramInitData, startTelegramBot, pollAndNotify }, { MODEL_OPTIONS, MODEL_GROUPS }] = await Promise.all([
  import('./store.js'), import('./provider.js'), import('./scoring.js'), import('./telegram.js'), import('./market.js')
]);

const port = Number(process.env.PORT || 3000);
const botToken = process.env.BOT_TOKEN || '';
const publicDir = path.resolve(projectDir, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function identity(req) {
  const initData = req.headers['x-telegram-init-data'] || '';
  if (!botToken) return { error: 'BOT_TOKEN не задан. Настрой токен Telegram-бота в .env.' };
  if (!initData) return { error: 'Открой приложение из Telegram. Нужна действительная Telegram-сессия.' };
  const result = validateTelegramInitData(initData, botToken);
  if (!result.ok) return { error: 'Не удалось подтвердить сессию Telegram. Перезапусти Mini App.' };
  return { userId: String(result.user.id), user: result.user };
}

async function readJson(req, maxBytes = 32768) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error('Слишком большой запрос');
  }
  if (!body) return {};
  return JSON.parse(body);
}

async function serveStatic(urlPath, res) {
  const decoded = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const filename = path.resolve(publicDir, `.${decoded}`);
  if (!filename.startsWith(`${publicDir}${path.sep}`)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const content = await fs.readFile(filename);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': path.extname(filename) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
  } catch (error) {
    sendJson(res, error.code === 'ENOENT' ? 404 : 500, { error: 'Не найдено' });
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, status: sourceStatus() });
    if (url.pathname.startsWith('/api/')) {
      const auth = identity(req);
      if (auth.error) return sendJson(res, 401, { error: auth.error });
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        try {
          const user = getUser(auth.userId);
          const fetched = await fetchListings();
          return sendJson(res, 200, {
            user: { id: auth.userId, name: auth.user.first_name || 'Пользователь' },
            settings: user.settings, defaults: DEFAULT_SETTINGS, modelOptions: MODEL_OPTIONS, modelGroups: MODEL_GROUPS,
            listings: scoreListings(fetched.listings, user.settings),
            marketBenchmarks: getMarketBenchmarks(), source: sourceStatus(), refreshedAt: fetched.fetchedAt
          });
        } catch (error) {
          console.error('bootstrap error:', error.message);
          return sendJson(res, 503, { error: `Не получилось загрузить объявления: ${error.message}` });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        try {
          const body = await readJson(req);
          const user = await updateSettings(auth.userId, body);
          return sendJson(res, 200, { settings: user.settings });
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof SyntaxError ? 'Некорректный JSON.' : 'Не удалось сохранить настройки.' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        try {
          const fetched = await fetchListings({ force: true });
          const user = getUser(auth.userId);
          return sendJson(res, 200, { listings: scoreListings(fetched.listings, user.settings), source: sourceStatus(), refreshedAt: fetched.fetchedAt });
        } catch (error) {
          return sendJson(res, 503, { error: `Источник объявлений недоступен: ${error.message}` });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/market') return sendJson(res, 200, { benchmarks: getMarketBenchmarks(), source: sourceStatus() });
      return sendJson(res, 404, { error: 'API route not found' });
    }
    if (req.method === 'GET' && !url.pathname.includes('..')) return await serveStatic(url.pathname, res);
    return sendJson(res, 404, { error: 'Не найдено' });
  } catch (error) {
    console.error('Request error:', error.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
    else res.end();
  }
});

await initStore();
startTelegramBot();
server.listen(port, () => {
  console.log(`iPhone Deal Hunter listening on http://localhost:${port}`);
  console.log(`Listing provider: ${sourceStatus().mode}; Telegram bot: ${botToken ? 'configured' : 'not configured'}`);
});

const intervalMinutes = Math.max(5, Number(process.env.POLL_INTERVAL_MINUTES || 5));
setTimeout(() => { void pollAndNotify(); }, 5_000);
setInterval(() => { void pollAndNotify(); }, intervalMinutes * 60 * 1000);
