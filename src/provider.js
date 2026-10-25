import { MARKET_BENCHMARKS } from './market.js';
import { normalizeDirectAvitoUrl } from './listing-url.js';

const CACHE_MS = 120_000;
const MIN_REQUEST_GAP_MS = 30_000;
const DEFAULT_PUBLIC_SEARCH_URL = 'https://www.avito.ru/all/telefony?q=iPhone';
const USER_AGENT = 'iPhoneRadar/1.3 (public listing search; no access-control bypass)';

let cache = { fetchedAt: 0, listings: [], provider: null };
let inFlight = null;
let lastError = null;
let lastAttemptAt = 0;

function validatePublicSearchUrl(raw) {
  const url = new URL(raw || DEFAULT_PUBLIC_SEARCH_URL);
  if (url.protocol !== 'https:' || !['avito.ru', 'www.avito.ru', 'm.avito.ru'].includes(url.hostname.toLowerCase())) {
    throw new Error('AVITO_PUBLIC_SEARCH_URL должен вести на публичную страницу поиска avito.ru по HTTPS.');
  }
  return url.toString();
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag).match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : null;
}

function markerElement(html, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([a-z][a-z0-9]*)\\b(?=[^>]*data-marker\\s*=\\s*["']${escaped}["'])[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'i');
  return html.match(re)?.[0] || '';
}

function markerText(html, markers) {
  for (const marker of markers) {
    const block = markerElement(html, marker);
    if (block) {
      const text = stripTags(block);
      if (text) return text;
      const tag = block.match(/^<[a-z][^>]*>/i)?.[0] || '';
      const content = getAttribute(tag, 'content');
      if (content) return content;
    }
  }
  return '';
}

function markerPrice(html) {
  const block = markerElement(html, 'item-price');
  if (!block) return 0;
  const priceTag = block.match(/<[^>]+(?:itemprop=["']price["']|data-marker=["']item-price["'])[^>]*>/i)?.[0] || block.match(/^<[a-z][^>]*>/i)?.[0] || '';
  const content = getAttribute(priceTag, 'content');
  const text = content || stripTags(block);
  const digits = String(text).replace(/\u00a0/g, ' ').replace(/[^\d]/g, '');
  return Number(digits) || 0;
}

function markerImage(html) {
  const image = html.match(/<img\b[^>]*>/i)?.[0] || '';
  const raw = getAttribute(image, 'data-src') || getAttribute(image, 'src') || getAttribute(image, 'srcset')?.split(/\s+/)[0] || '';
  try {
    const url = new URL(raw, 'https://www.avito.ru');
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function parsePublicAvitoHtml(html) {
  if (/(?:captcha|robot check|проверка браузера|подтвердите, что вы не робот|доступ ограничен)/i.test(html)) {
    throw new Error('Avito попросил пройти проверку или ограничил автоматический запрос. Проверки не обходятся; попробуйте позже или подключите REEFAPI_KEY.');
  }

  const starts = [...html.matchAll(/<[^>]+\bdata-marker\s*=\s*["']item["'][^>]*>/gi)];
  if (!starts.length) {
    if (/(?:ничего не найдено|по вашему запросу ничего не найдено|объявления не найдены)/i.test(stripTags(html))) return [];
    throw new Error('Не удалось распознать карточки в публичной выдаче Avito: возможно, разметка изменилась или выдача недоступна. Можно указать REEFAPI_KEY.');
  }

  const result = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const card = html.slice(start, end);
    const rootTag = starts[i][0];
    const titleBlock = markerElement(card, 'item-title');
    const titleTag = titleBlock.match(/^<a\b[^>]*>/i)?.[0] || titleBlock.match(/^<[a-z][^>]*>/i)?.[0] || '';
    const href = getAttribute(titleTag, 'href');
    let directUrl = null;
    if (href) {
      try { directUrl = normalizeDirectAvitoUrl(new URL(href, 'https://www.avito.ru').toString()); } catch { /* invalid link */ }
    }
    const itemId = getAttribute(rootTag, 'data-item-id') || (directUrl?.match(/(\d{7,})(?:\D*)$/)?.[1] ?? null);
    const title = markerText(card, ['item-title']);
    const price = markerPrice(card);
    if (!title || !/iphone|айфон/i.test(title) || !price || !directUrl) continue;
    result.push({
      id: String(itemId || directUrl),
      title,
      price,
      description: markerText(card, ['item-description', 'item-snippet']),
      location: markerText(card, ['item-location', 'item-address']),
      sellerType: 'unknown',
      personType: 0,
      createdAt: markerText(card, ['item-date']) || null,
      url: directUrl,
      image: markerImage(card),
      sourceId: 1
    });
  }
  return result;
}

function getNestedArray(payload) {
  const candidates = [
    payload?.data?.listings,
    payload?.listings,
    payload?.data?.items,
    payload?.items,
    payload?.data?.ads,
    payload?.ads,
    payload?.results,
    payload?.announcements
  ];
  const found = candidates.find(Array.isArray);
  if (found) return found;
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeAd(ad) {
  const image = Array.isArray(ad.images) ? ad.images[0] : ad.image;
  const imageUrl = typeof image === 'string' ? image : image?.imgurl || image?.url || null;
  const location = ad.location && typeof ad.location === 'object'
    ? ad.location.name || ad.location.address || ''
    : ad.location || ad.address || ad.city || '';
  const sellerTypeRaw = String(ad.seller?.type || ad.seller_type || '').toLowerCase();
  const personType = Number(ad.person_type ?? ad.personType ?? 0);
  const sellerType = ['private', 'person', 'частное лицо'].includes(sellerTypeRaw) || personType === 1 || personType === 3
    ? 'private'
    : ['business', 'company', 'businesses', 'компания'].includes(sellerTypeRaw) || personType === 2 ? 'business' : 'unknown';
  const rawUrl = ad.url || ad.link || ad.ad_url || ad.item_url || ad.web_url;
  return {
    id: String(ad.ad_id ?? ad.avitoid ?? ad.id ?? ad.listing_id ?? `${rawUrl || ad.title}-${ad.price}`),
    title: String(ad.title || ad.name || 'Объявление без названия'),
    price: Number(String(ad.price ?? 0).replace(/[^\d]/g, '')),
    description: String(ad.description || ad.text || ad.description_snippet || ad.subtitle || ''),
    location: String(location || ''),
    sellerType,
    personType,
    createdAt: ad.published_at || ad.time_source_created || ad.time || ad.created_at || null,
    url: normalizeDirectAvitoUrl(rawUrl),
    image: typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl) ? imageUrl : null,
    sourceId: 1
  };
}

async function fetchPublicAvito() {
  const url = validatePublicSearchUrl(process.env.AVITO_PUBLIC_SEARCH_URL || DEFAULT_PUBLIC_SEARCH_URL);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      'User-Agent': USER_AGENT
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(18_000)
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error(`Публичная выдача Avito вернула HTTP ${response.status}. Скрипт не обходит ограничения; повторите позже или настройте REEFAPI_KEY.`);
  }
  if (!response.ok) throw new Error(`Публичная выдача Avito ответила HTTP ${response.status}.`);
  const finalUrl = new URL(response.url || url);
  if (!['avito.ru', 'www.avito.ru', 'm.avito.ru'].includes(finalUrl.hostname.toLowerCase())) {
    throw new Error('Avito перенаправил запрос на посторонний домен, поэтому источник остановлен.');
  }
  const html = await response.text();
  const listings = parsePublicAvitoHtml(html).map(normalizeAd).filter(isValidListing);
  return { listings, provider: 'public-avito' };
}

async function fetchReefApi() {
  const key = process.env.REEFAPI_KEY?.trim();
  if (!key) throw new Error('REEFAPI_KEY не задан.');
  const body = {
    query: 'iPhone',
    sort: 'newest',
    page: 1,
    include_sponsored: false,
    include_pii: false,
    category_detection: false
  };
  const location = process.env.REEFAPI_LOCATION?.trim();
  if (location && location.toLowerCase() !== 'all') body.location = location;
  const response = await fetch('https://api.reefapi.com/avito/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': key, 'User-Agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`ReefAPI ответил HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload?.ok || payload?.error) throw new Error(String(payload?.error?.message || payload?.error || 'ReefAPI вернул ошибку.'));
  const listings = getNestedArray(payload).map(normalizeAd).filter(isValidListing);
  return { listings, provider: 'reefapi' };
}

function isValidListing(item) {
  return item.price > 0 && Boolean(item.url) && /iphone|айфон/i.test(`${item.title} ${item.description}`);
}

async function loadFromConfiguredSource() {
  const reefKey = process.env.REEFAPI_KEY?.trim();
  if (reefKey) {
    try {
      return await fetchReefApi();
    } catch (reefError) {
      // Try the public page as a no-key fallback; never suppress both errors.
      try {
        const result = await fetchPublicAvito();
        result.fallbackNote = `ReefAPI недоступен (${reefError.message}); сработала публичная выдача Avito.`;
        return result;
      } catch (publicError) {
        throw new Error(`ReefAPI: ${reefError.message} Публичная выдача: ${publicError.message}`);
      }
    }
  }
  return fetchPublicAvito();
}

export async function fetchListings({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.fetchedAt && now - cache.fetchedAt < CACHE_MS) return cache;
  if (inFlight) return inFlight;
  if (lastAttemptAt && now - lastAttemptAt < MIN_REQUEST_GAP_MS) {
    if (cache.fetchedAt) return cache;
    if (lastError) throw new Error(lastError);
  }

  lastAttemptAt = now;
  lastError = null;
  inFlight = (async () => {
    const result = await loadFromConfiguredSource();
    cache = { fetchedAt: Date.now(), listings: result.listings, provider: result.provider };
    lastError = result.fallbackNote || null;
    return cache;
  })();
  try {
    return await inFlight;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    inFlight = null;
  }
}

export function clearProviderCache() {
  cache = { fetchedAt: 0, listings: [], provider: null };
  inFlight = null;
  lastError = null;
  lastAttemptAt = 0;
}

export function sourceStatus() {
  const reefConfigured = Boolean(process.env.REEFAPI_KEY?.trim());
  const provider = cache.provider || (reefConfigured ? 'reefapi' : 'public-avito');
  const providerLabel = provider === 'reefapi' ? 'REEFAPI · AVITO' : 'AVITO · ПУБЛИЧНЫЙ ПОИСК';
  let mode = 'connecting';
  let label = providerLabel;
  let note = reefConfigured
    ? 'Поиск выполняется через ReefAPI; бизнес-аккаунт Avito не нужен. При сбое попробуем публичную выдачу Avito.'
    : 'Используется открытая страница поиска Avito без ключей API. Доступность зависит от публичной выдачи и ограничений сайта.';

  if (lastError) {
    mode = cache.fetchedAt ? 'live' : 'error';
    label = cache.fetchedAt ? 'ПОИСК LIVE · FALLBACK' : 'ИСТОЧНИК НЕДОСТУПЕН';
    note = cache.fetchedAt ? `${lastError} Получено реальных объявлений: ${cache.listings.length}.` : lastError;
  } else if (cache.fetchedAt) {
    mode = 'live';
    label = providerLabel;
    note = cache.listings.length
      ? `Источник вернул ${cache.listings.length} реальных объявлений с прямыми ссылками на карточки Avito.`
      : 'Источник ответил, но не вернул подходящих объявлений с прямыми ссылками. Никакие демо-карточки не подставляются.';
  }

  return { mode, label, note, lastUpdated: cache.fetchedAt || null, count: cache.listings.length, provider };
}

export function getMarketBenchmarks() {
  return MARKET_BENCHMARKS;
}

// Exported for deterministic parser tests. This does not access the network.
export const __test = { parsePublicAvitoHtml, normalizeAd, validatePublicSearchUrl };
