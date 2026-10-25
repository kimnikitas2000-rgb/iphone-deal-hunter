// Indicative fallback prices for USED devices in the Russian market. Values for
// the base models are the original public-market benchmarks; Pro/Plus/mini/e/Air
// variants are calculated estimates until enough comparable listings are found.
// They are fallbacks, not live offers or a warranty of value.
const BASE_MARKET_BENCHMARKS = {
  'iPhone 11': { 64: 12000, 128: 14000, 256: 16000, 512: 18000 },
  'iPhone 12': { 64: 13000, 128: 16000, 256: 18500, 512: 21000 },
  'iPhone 13': { 128: 22000, 256: 25500, 512: 30000, 1024: 35000 },
  'iPhone 14': { 128: 31500, 256: 35000, 512: 39000, 1024: 45000 },
  'iPhone 15': { 128: 35500, 256: 40000, 512: 45000, 1024: 51000 },
  'iPhone 16': { 128: 47500, 256: 52500, 512: 59000, 1024: 67000 },
  'iPhone 17': { 256: 67000, 512: 96400, 1024: 112000, 2048: 135000 },
  'iPhone 18 Pro': { 256: 119000, 512: 143000, 1024: 192000, 2048: 237000 },
  'iPhone 18 Pro Max': { 256: 134000, 512: 159000, 1024: 209000, 2048: 252000 }
};

export const MODEL_GROUPS = [
  { family: 'iPhone 11', models: ['iPhone 11', 'iPhone 11 Pro', 'iPhone 11 Pro Max'] },
  { family: 'iPhone 12', models: ['iPhone 12', 'iPhone 12 mini', 'iPhone 12 Pro', 'iPhone 12 Pro Max'] },
  { family: 'iPhone 13', models: ['iPhone 13', 'iPhone 13 mini', 'iPhone 13 Pro', 'iPhone 13 Pro Max'] },
  { family: 'iPhone 14', models: ['iPhone 14', 'iPhone 14 Plus', 'iPhone 14 Pro', 'iPhone 14 Pro Max'] },
  { family: 'iPhone 15', models: ['iPhone 15', 'iPhone 15 Plus', 'iPhone 15 Pro', 'iPhone 15 Pro Max'] },
  { family: 'iPhone 16', models: ['iPhone 16', 'iPhone 16 Plus', 'iPhone 16e', 'iPhone 16 Pro', 'iPhone 16 Pro Max'] },
  { family: 'iPhone 17', models: ['iPhone 17', 'iPhone 17e', 'iPhone Air', 'iPhone 17 Pro', 'iPhone 17 Pro Max'] },
  { family: 'iPhone 18', models: ['iPhone 18 Pro', 'iPhone 18 Pro Max'] }
];
export const MODEL_OPTIONS = MODEL_GROUPS.flatMap(group => group.models);
export const STORAGE_OPTIONS = [64, 128, 256, 512, 1024, 2048];

const VARIANT_MULTIPLIER = {
  mini: 0.90,
  e: 0.84,
  plus: 1.08,
  air: 1.18,
  pro: 1.22,
  'pro max': 1.35
};
const STORAGE_BY_MODEL = {
  'iPhone 11': [64, 128, 256],
  'iPhone 11 Pro': [64, 256, 512],
  'iPhone 11 Pro Max': [64, 256, 512],
  'iPhone 12': [64, 128, 256],
  'iPhone 12 mini': [64, 128, 256],
  'iPhone 12 Pro': [128, 256, 512],
  'iPhone 12 Pro Max': [128, 256, 512],
  'iPhone 13': [128, 256, 512],
  'iPhone 13 mini': [128, 256, 512],
  'iPhone 13 Pro': [128, 256, 512, 1024],
  'iPhone 13 Pro Max': [128, 256, 512, 1024],
  'iPhone 14': [128, 256, 512],
  'iPhone 14 Plus': [128, 256, 512],
  'iPhone 14 Pro': [128, 256, 512, 1024],
  'iPhone 14 Pro Max': [128, 256, 512, 1024],
  'iPhone 15': [128, 256, 512],
  'iPhone 15 Plus': [128, 256, 512],
  'iPhone 15 Pro': [128, 256, 512, 1024],
  'iPhone 15 Pro Max': [256, 512, 1024],
  'iPhone 16': [128, 256, 512],
  'iPhone 16 Plus': [128, 256, 512],
  'iPhone 16e': [128, 256, 512],
  'iPhone 16 Pro': [128, 256, 512, 1024],
  'iPhone 16 Pro Max': [256, 512, 1024],
  'iPhone 17': [256, 512],
  'iPhone 17e': [256, 512],
  'iPhone Air': [256, 512, 1024],
  'iPhone 17 Pro': [256, 512, 1024],
  'iPhone 17 Pro Max': [256, 512, 1024, 2048],
  'iPhone 18 Pro': [256, 512, 1024, 2048],
  'iPhone 18 Pro Max': [256, 512, 1024, 2048]
};

function familyOf(model) {
  const match = String(model).match(/^iPhone (1[1-8])/);
  return match ? `iPhone ${match[1]}` : null;
}
function variantOf(model) {
  const match = String(model).match(/^iPhone (?:1[1-8])(?: ?(Pro Max|Pro|Plus|mini|e))$/i);
  if (match) return match[1].toLowerCase();
  if (model === 'iPhone Air') return 'air';
  return '';
}
function roundHundred(value) { return Math.round(value / 100) * 100; }

function extrapolateBasePrice(family, storage) {
  const prices = BASE_MARKET_BENCHMARKS[family];
  if (!prices) return null;
  if (prices[storage] !== undefined) return prices[storage];
  const sizes = Object.keys(prices).map(Number).sort((a, b) => a - b);
  if (!sizes.length) return null;
  const exactLower = sizes.filter(size => size < storage).at(-1);
  const exactUpper = sizes.find(size => size > storage);
  if (exactLower && exactUpper) {
    const ratio = Math.log2(storage / exactLower) / Math.log2(exactUpper / exactLower);
    return prices[exactLower] + (prices[exactUpper] - prices[exactLower]) * ratio;
  }
  const closest = exactLower || exactUpper || sizes[0];
  const steps = Math.abs(Math.log2(storage / closest));
  return prices[closest] * (exactLower ? 1 + 0.17 * steps : Math.max(0.8, 1 - 0.12 * steps));
}

const MARKET_BENCHMARKS = { ...BASE_MARKET_BENCHMARKS };
for (const model of MODEL_OPTIONS) {
  if (MARKET_BENCHMARKS[model]) continue;
  const family = familyOf(model);
  const multiplier = VARIANT_MULTIPLIER[variantOf(model)] || 1;
  const storageMap = {};
  for (const storage of STORAGE_BY_MODEL[model] || []) {
    const base = extrapolateBasePrice(family, storage);
    if (base !== null) storageMap[storage] = roundHundred(base * multiplier);
  }
  MARKET_BENCHMARKS[model] = storageMap;
}
export { MARKET_BENCHMARKS };

export function isCalculatedVariant(model) {
  return !Object.hasOwn(BASE_MARKET_BENCHMARKS, model);
}

export function fallbackMarketPrice(model, storage) {
  const modelBenchmarks = MARKET_BENCHMARKS[model];
  if (!modelBenchmarks) return null;
  return modelBenchmarks[storage] ?? null;
}
