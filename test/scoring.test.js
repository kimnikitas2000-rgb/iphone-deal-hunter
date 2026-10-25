import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseModel, parseModelFamily, parseStorage, parseBattery, scoreListings } from '../src/scoring.js';
import { validateTelegramInitData } from '../src/telegram.js';
import { MODEL_OPTIONS, fallbackMarketPrice } from '../src/market.js';
import { normalizeDirectAvitoUrl, isDirectAvitoUrl } from '../src/listing-url.js';

test('extracts iPhone model, memory, and battery percentage', () => {
  assert.equal(parseModel('Apple iPhone 13 Pro 128GB'), 'iPhone 13 Pro');
  assert.equal(parseModelFamily('iPhone 13 Pro'), 'iPhone 13');
  assert.equal(parseModel('Айфон 15, память 256 ГБ'), 'iPhone 15');
  assert.equal(parseModel('iPhone 14 Pro Max 256GB'), 'iPhone 14 Pro Max');
  assert.equal(parseModel('iPhone 18 Pro 256GB'), 'iPhone 18 Pro');
  assert.equal(parseModel('iPhone 15 Pro Max 256 ГБ'), 'iPhone 15 Pro Max');
  assert.equal(parseModel('iPhone 12 mini 64GB'), 'iPhone 12 mini');
  assert.equal(parseModel('iPhone 16e 256GB'), 'iPhone 16e');
  assert.equal(parseModel('iPhone 17e 256GB'), 'iPhone 17e');
  assert.equal(parseModel('Apple iPhone Air 256GB'), 'iPhone Air');
  assert.equal(parseModelFamily('iPhone 17e'), 'iPhone 17');
  assert.ok(MODEL_OPTIONS.includes('iPhone 15 Pro Max'));
  assert.ok(MODEL_OPTIONS.includes('iPhone 14 Plus'));
  assert.ok(fallbackMarketPrice('iPhone 13 Pro', 128) > 0);
  assert.ok(fallbackMarketPrice('iPhone 15 Pro Max', 256) > 0);
  assert.equal(parseStorage('iPhone 14 512 GB'), 512);
  assert.equal(parseStorage('iPhone 13 128 ГБ'), 128);
  assert.equal(parseBattery('Аккумулятор: 87%'), 87);
});

test('model filter matches exact variant rather than whole generation', () => {
  const settings = { models: ['iPhone 13 Pro'], storage: [128], city: 'Вся Россия', maxPrice: 60000, minDiscountPct: 0, minBatteryPct: 80, privateOnly: false };
  const result = scoreListings([
    { id: 'base', title: 'iPhone 13 128GB', price: 17800, location: 'Москва' },
    { id: 'pro', title: 'iPhone 13 Pro 128GB', price: 22000, location: 'Москва' }
  ], settings);
  assert.deepEqual(result.map(item => item.id), ['pro']);
});

test('only accepts direct Avito listing links', () => {
  const direct = 'https://www.avito.ru/moskva/telefony/iphone_13_128_gb_1234567890';
  assert.equal(normalizeDirectAvitoUrl(direct), direct);
  assert.equal(isDirectAvitoUrl('https://www.avito.ru/'), false);
  assert.equal(isDirectAvitoUrl('https://www.avito.ru/rossiya?q=iphone'), false);
  assert.equal(normalizeDirectAvitoUrl('https://example.com/item_1234567890'), null);
});

test('scores below-market items and flags dangerous prices', () => {
  const settings = { models: ['iPhone 13'], storage: [128], city: 'Вся Россия', maxPrice: 50000, minDiscountPct: 15, minBatteryPct: 80, privateOnly: false };
  const input = [
    { id: 'good', title: 'iPhone 13 128GB, АКБ 88%', price: 17800, location: 'Москва', url: 'https://www.avito.ru/' },
    { id: 'risk', title: 'iPhone 13 128GB iCloud заблокирован', price: 9000, location: 'Москва', url: 'https://www.avito.ru/' }
  ];
  const result = scoreListings(input, settings);
  assert.equal(result.length, 2);
  assert.equal(result.find(item => item.id === 'good').isDeal, true);
  assert.equal(result.find(item => item.id === 'risk').isRisky, true);
  assert.equal(result.find(item => item.id === 'risk').tooCheap, true);
});

test('validates Telegram Mini App initData signatures', () => {
  const botToken = '123456:fake-token-for-test';
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'test-query',
    user: JSON.stringify({ id: 12345, first_name: 'Test' })
  });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  const result = validateTelegramInitData(params.toString(), botToken);
  assert.equal(result.ok, true);
  assert.equal(result.user.id, 12345);
  params.set('user', JSON.stringify({ id: 999, first_name: 'Changed' }));
  assert.equal(validateTelegramInitData(params.toString(), botToken).ok, false);
});
