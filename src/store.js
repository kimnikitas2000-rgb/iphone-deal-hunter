import fs from 'node:fs/promises';
import path from 'node:path';
import { MODEL_OPTIONS, STORAGE_OPTIONS } from './market.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const FILE = path.join(DATA_DIR, 'state.json');
const MODEL_FILTER_VERSION = 2;
const DEFAULT_SETTINGS = {
  city: 'Вся Россия',
  models: [...MODEL_OPTIONS],
  storage: [...STORAGE_OPTIONS],
  maxPrice: 250000,
  minDiscountPct: 15,
  minBatteryPct: 80,
  minBatteryFilter: 0,
  privateOnly: false,
  notificationsEnabled: true
};
let state = { version: MODEL_FILTER_VERSION, users: {} };
let writeQueue = Promise.resolve();

export async function initStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let shouldPersist = false;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    if (parsed && parsed.users && typeof parsed.users === 'object') {
      state = { ...parsed, version: MODEL_FILTER_VERSION };
      for (const user of Object.values(state.users)) {
        if (user.modelFilterVersion === MODEL_FILTER_VERSION) continue;
        const oldModels = user.settings?.models;
        if (Array.isArray(oldModels) && oldModels.length && oldModels.every(model => /^iPhone 1[1-8]$/.test(model))) {
          // In the previous version a single generation button meant the whole family.
          // Expand those old selections once so existing filters keep their intent.
          user.settings.models = MODEL_OPTIONS.filter(model => oldModels.some(family => model === family || model.startsWith(`${family} `)));
        } else if (Array.isArray(oldModels)) {
          user.settings.models = oldModels.filter(model => MODEL_OPTIONS.includes(model));
        } else {
          user.settings.models = [...MODEL_OPTIONS];
        }
        user.modelFilterVersion = MODEL_FILTER_VERSION;
        shouldPersist = true;
      }
      if (parsed.version !== MODEL_FILTER_VERSION) shouldPersist = true;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Не удалось прочитать state.json:', error.message);
    shouldPersist = true;
  }
  if (shouldPersist) await persist();
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temp = `${FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temp, FILE);
  }).catch(error => console.error('Не удалось сохранить состояние:', error.message));
  return writeQueue;
}

export function getUser(userId) {
  const key = String(userId);
  if (!state.users[key]) {
    state.users[key] = {
      settings: structuredClone(DEFAULT_SETTINGS),
      chatId: null,
      initialized: false,
      notifiedIds: [],
      modelFilterVersion: MODEL_FILTER_VERSION,
      createdAt: new Date().toISOString()
    };
    void persist();
  }
  return state.users[key];
}

export async function updateSettings(userId, patch) {
  const user = getUser(userId);
  const input = patch && typeof patch === 'object' ? patch : {};
  user.settings = {
    ...user.settings,
    city: typeof input.city === 'string' ? input.city.slice(0, 80).trim() || 'Вся Россия' : user.settings.city,
    models: Array.isArray(input.models) ? [...new Set(input.models.filter(x => MODEL_OPTIONS.includes(x)))] : user.settings.models,
    storage: Array.isArray(input.storage) ? input.storage.map(Number).filter(x => STORAGE_OPTIONS.includes(x)) : user.settings.storage,
    maxPrice: clamp(input.maxPrice, 0, 500000, user.settings.maxPrice),
    minDiscountPct: clamp(input.minDiscountPct, 0, 80, user.settings.minDiscountPct),
    minBatteryPct: clamp(input.minBatteryPct, 50, 100, user.settings.minBatteryPct),
    minBatteryFilter: clamp(input.minBatteryFilter, 0, 100, user.settings.minBatteryFilter),
    privateOnly: typeof input.privateOnly === 'boolean' ? input.privateOnly : user.settings.privateOnly,
    notificationsEnabled: typeof input.notificationsEnabled === 'boolean' ? input.notificationsEnabled : user.settings.notificationsEnabled
  };
  user.modelFilterVersion = MODEL_FILTER_VERSION;
  await persist();
  return user;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function setChatId(userId, chatId) {
  const user = getUser(userId);
  user.chatId = chatId;
  await persist();
}

export async function getAllUsers() {
  return Object.entries(state.users).map(([id, user]) => ({ id, ...user }));
}

export async function markInitialized(userId, ids = []) {
  const user = getUser(userId);
  user.initialized = true;
  user.notifiedIds = [...new Set([...(user.notifiedIds || []), ...ids.map(String)])].slice(-3000);
  await persist();
}

export async function markNotified(userId, ids = []) {
  const user = getUser(userId);
  user.notifiedIds = [...new Set([...(user.notifiedIds || []), ...ids.map(String)])].slice(-3000);
  await persist();
}

export { DEFAULT_SETTINGS };
