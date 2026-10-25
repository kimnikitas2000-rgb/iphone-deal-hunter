import { fallbackMarketPrice, isCalculatedVariant } from './market.js';

const HIGH_RISK_TERMS = [
  'icloud', 'залоч', 'заблок', 'не работает', 'нерабоч', 'на запчаст',
  'под ремонт', 'не включ', 'face id не', 'faceid не', 'разбит', 'трещин',
  'утоплен', 'утопленник', 'материнск', 'плата не', 'не активируется',
  'обход', 'мимо imei'
];
const REPAIR_TERMS = [
  'замена экрана', 'разбит экран', 'трещина', 'не работает face id',
  'не работает камера', 'не работает динамик', 'после воды', 'утоплен',
  'ремонт', 'не работает дисплей'
];

export function parseModel(title = '') {
  const t = title.toLowerCase().replace(/ё/g, 'е');
  // iPhone Air is a standalone model name, not "iPhone 17 Air".
  if (/(?:iphone|айфон)\s+air\b/i.test(t)) return 'iPhone Air';
  const match = t.match(/(?:iphone|айфон)\s*(1[1-8])(?:\s*(pro\s*max|pro|max|plus|mini|air|e))?\b/i);
  const n = match?.[1];
  if (!n) return null;
  const rawVariant = (match?.[2] || '').replace(/\s+/g, ' ').trim();
  const variant = ({ 'pro max': 'Pro Max', 'pro': 'Pro', 'max': 'Max', 'plus': 'Plus', 'mini': 'mini', 'air': 'Air', 'e': 'e' })[rawVariant] || '';
  if (variant === 'Air') return 'iPhone Air';
  return `iPhone ${n}${variant === 'e' ? 'e' : variant ? ` ${variant}` : ''}`;
}

export function parseModelFamily(model = '') {
  const match = String(model).match(/^iPhone (1[1-8])(?:\b|(?=[a-z]))/i);
  if (match) return `iPhone ${match[1]}`;
  if (model === 'iPhone Air') return 'iPhone 17';
  return null;
}

export function parseStorage(text = '') {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const patterns = [
    [2048, /(?:2\s*(?:тб|tb|терабайт)|2048\s*(?:гб|gb)?)/],
    [1024, /(?:1\s*(?:тб|tb|терабайт)|1024\s*(?:гб|gb)?)/],
    [512, /(?:512\s*(?:гб|gb|гиг|гигабайт)?|полтерабайт)/],
    [256, /(?:256\s*(?:гб|gb|гиг|гигабайт)?|четвертьтерабайт)/],
    [128, /128\s*(?:гб|gb|гиг|гигабайт)?/],
    [64, /64\s*(?:гб|gb|гиг|гигабайт)?/]
  ];
  for (const [gb, re] of patterns) if (re.test(t)) return gb;
  return null;
}

export function parseBattery(text = '') {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  const matches = [
    ...t.matchAll(/(?:акб|аккумулятор|батарея|battery|состояние аккумулятора)?\s*[:\-]?\s*(\d{2,3})\s*%/g)
  ];
  for (const match of matches) {
    const n = Number(match[1]);
    if (n >= 50 && n <= 100) return n;
  }
  return null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function textOf(item) {
  return `${item.title || ''} ${item.description || ''}`.toLowerCase().replace(/ё/g, 'е');
}

export function scoreListings(listings, settings = {}) {
  const parsed = listings.map(item => {
    const text = textOf(item);
    const model = parseModel(item.title || '');
    const modelFamily = parseModelFamily(model);
    const storage = parseStorage(`${item.title || ''} ${item.description || ''}`);
    const batteryPct = parseBattery(`${item.title || ''} ${item.description || ''}`);
    const isRisky = HIGH_RISK_TERMS.some(term => text.includes(term));
    const repairRisk = REPAIR_TERMS.some(term => text.includes(term));
    return { ...item, model, modelFamily, storage, batteryPct, isRisky, repairRisk, price: Number(item.price) };
  });

  return parsed.map(item => {
    const comparablePrices = parsed
      .filter(other => other.id !== item.id && other.model === item.model && other.storage === item.storage)
      .filter(other => Number.isFinite(other.price) && other.price > 0)
      .filter(other => {
        const fallback = fallbackMarketPrice(item.model, item.storage);
        return !fallback || (other.price >= fallback * 0.45 && other.price <= fallback * 2.2);
      })
      .map(other => other.price);

    const learned = comparablePrices.length >= 6 ? median(comparablePrices) : null;
    const marketPrice = learned ?? fallbackMarketPrice(item.model, item.storage);
    const marketConfidence = learned ? 'По похожим объявлениям' : (marketPrice && isCalculatedVariant(item.model) ? 'Расчётный ориентир' : 'Ориентир по рынку');
    const discountPct = marketPrice && item.price > 0
      ? Math.round((marketPrice - item.price) / marketPrice * 100)
      : null;
    const tooCheap = Boolean(marketPrice && item.price > 0 && item.price < marketPrice * 0.55);
    const batteryLow = item.batteryPct !== null && item.batteryPct < Number(settings.minBatteryPct ?? 80);
    const city = (settings.city || 'Вся Россия').trim().toLocaleLowerCase('ru-RU');
    const listingLocation = String(item.location || '').toLocaleLowerCase('ru-RU');
    const cityMatches = !city || city === 'вся россия' || !listingLocation || listingLocation.includes(city);
    const modelMatches = !settings.models?.length || settings.models.includes(item.model);
    const storageMatches = !settings.storage?.length || !item.storage || settings.storage.includes(item.storage);
    const maxPrice = Number(settings.maxPrice || 0);
    const priceMatches = !maxPrice || item.price <= maxPrice;
    const privateMatches = !settings.privateOnly || item.sellerType === 'private' || item.sellerType === 'person' || item.personType === 1;
    const batteryMatches = item.batteryPct === null || !settings.minBatteryFilter || item.batteryPct >= Number(settings.minBatteryFilter);
    const visible = cityMatches && modelMatches && storageMatches && priceMatches && privateMatches && batteryMatches;

    let status = 'Рыночная';
    if (tooCheap || item.isRisky) status = 'Риск: проверь';
    else if (discountPct !== null && discountPct >= Number(settings.minDiscountPct ?? 15)) status = 'Выгодно';
    else if (discountPct !== null && discountPct >= 8) status = 'Стоит проверить';

    let riskNotes = [];
    if (tooCheap) riskNotes.push('Цена намного ниже ориентира — возможен обман или неисправность');
    if (item.isRisky) riskNotes.push('В тексте есть признаки блокировки или неисправности');
    if (item.repairRisk && !item.isRisky) riskNotes.push('Возможны расходы на ремонт');
    if (batteryLow) riskNotes.push(`Аккумулятор ${item.batteryPct}% — ниже выбранного порога`);
    if (item.batteryPct === null) riskNotes.push('Ёмкость аккумулятора не указана');

    return {
      ...item,
      marketPrice,
      marketConfidence,
      discountPct,
      status,
      tooCheap,
      batteryLow,
      visible,
      riskNotes,
      isDeal: visible && !tooCheap && !item.isRisky && discountPct !== null && discountPct >= Number(settings.minDiscountPct ?? 15)
    };
  }).filter(item => item.visible).sort((a, b) => {
    const aDiscount = a.discountPct ?? -999;
    const bDiscount = b.discountPct ?? -999;
    if (a.tooCheap !== b.tooCheap) return a.tooCheap ? 1 : -1;
    return bDiscount - aDiscount;
  });
}
