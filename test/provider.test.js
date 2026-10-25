import test from 'node:test';
import assert from 'node:assert/strict';
import { __test, clearProviderCache, fetchListings, sourceStatus } from '../src/provider.js';

function saveEnv(keys) {
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  return () => {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  };
}

const searchHtml = `<!doctype html><html><body>
  <div data-marker="item" data-item-id="1234567890">
    <a data-marker="item-title" href="/moskva/telefony/iphone_13_128gb_1234567890"><h3>Apple iPhone 13 128 ГБ</h3></a>
    <span data-marker="item-price">19 000 ₽</span>
    <div data-marker="item-location">Москва</div>
    <img data-marker="item-image" src="https://images.example.test/iphone13.jpg" />
    <p data-marker="item-description">Аккумулятор 88%, без ремонта</p>
  </div>
  <div data-marker="item" data-item-id="1234567891">
    <a data-marker="item-title" href="/moskva/telefony/iphone_14_128gb_1234567891"><h3>Apple iPhone 14 128 ГБ</h3></a>
    <span data-marker="item-price">25 000 ₽</span>
    <div data-marker="item-location">Москва</div>
  </div>
  <div data-marker="item" data-item-id="1234567892">
    <a data-marker="item-title" href="/"><h3>iPhone 15 — ссылка на главную некорректна</h3></a>
    <span data-marker="item-price">30 000 ₽</span>
  </div>
</body></html>`;

test('uses public Avito search without API keys and returns only direct real listing links', async () => {
  const restore = saveEnv(['ADS_API_USER', 'ADS_API_TOKEN', 'REEFAPI_KEY', 'REEFAPI_LOCATION', 'AVITO_PUBLIC_SEARCH_URL']);
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.ADS_API_USER;
    delete process.env.ADS_API_TOKEN;
    delete process.env.REEFAPI_KEY;
    process.env.AVITO_PUBLIC_SEARCH_URL = 'https://www.avito.ru/all/telefony?q=iPhone';
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /^https:\/\/www\.avito\.ru\//);
      assert.equal(init.method, 'GET');
      return new Response(searchHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    };
    clearProviderCache();

    const result = await fetchListings({ force: true });
    assert.equal(result.listings.length, 2);
    assert.equal(result.listings[0].id, '1234567890');
    assert.equal(result.listings[0].price, 19000);
    assert.equal(result.listings[0].location, 'Москва');
    assert.equal(result.listings[0].url, 'https://www.avito.ru/moskva/telefony/iphone_13_128gb_1234567890');
    assert.equal(result.listings[0].description, 'Аккумулятор 88%, без ремонта');
    assert.equal(result.provider, 'public-avito');
    assert.equal(sourceStatus().mode, 'live');
    assert.equal(sourceStatus().count, 2);
  } finally {
    clearProviderCache();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('uses optional ReefAPI key without Avito business API credentials', async () => {
  const restore = saveEnv(['ADS_API_USER', 'ADS_API_TOKEN', 'REEFAPI_KEY', 'REEFAPI_LOCATION', 'AVITO_PUBLIC_SEARCH_URL']);
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.ADS_API_USER;
    delete process.env.ADS_API_TOKEN;
    process.env.REEFAPI_KEY = 'test-reef-key';
    process.env.REEFAPI_LOCATION = 'moskva';
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.reefapi.com/avito/v1/search');
      assert.equal(init.headers['x-api-key'], 'test-reef-key');
      const requestBody = JSON.parse(init.body);
      assert.equal(requestBody.query, 'iPhone');
      assert.equal(requestBody.location, 'moskva');
      return new Response(JSON.stringify({
        ok: true,
        data: { listings: [
          { ad_id: '1234567890', title: 'Apple iPhone 13 128 ГБ', price: 19000, url: 'https://www.avito.ru/moskva/telefony/iphone_13_128gb_1234567890', published_at: '2026-10-24T12:00:00Z', location: { name: 'Москва' }, seller: { type: 'private' }, images: ['https://images.example.test/iphone.jpg'], description_snippet: 'Аккумулятор 88%' },
          { ad_id: '1234567891', title: 'iPhone 14', price: 25000, url: 'https://www.avito.ru/' }
        ] }, meta: { mode: 'live' }, error: null
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    clearProviderCache();

    const result = await fetchListings({ force: true });
    assert.equal(result.provider, 'reefapi');
    assert.equal(result.listings.length, 1);
    assert.equal(result.listings[0].id, '1234567890');
    assert.equal(result.listings[0].sellerType, 'private');
    assert.equal(result.listings[0].image, 'https://images.example.test/iphone.jpg');
    assert.equal(sourceStatus().mode, 'live');
  } finally {
    clearProviderCache();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('reports public-source access blocks without fabricating listings', async () => {
  const restore = saveEnv(['ADS_API_USER', 'ADS_API_TOKEN', 'REEFAPI_KEY', 'AVITO_PUBLIC_SEARCH_URL']);
  const originalFetch = globalThis.fetch;
  try {
    delete process.env.ADS_API_USER;
    delete process.env.ADS_API_TOKEN;
    delete process.env.REEFAPI_KEY;
    process.env.AVITO_PUBLIC_SEARCH_URL = 'https://www.avito.ru/all/telefony?q=iPhone';
    globalThis.fetch = async () => new Response('Access denied', { status: 403 });
    clearProviderCache();

    await assert.rejects(() => fetchListings({ force: true }), /HTTP 403/);
    assert.equal(sourceStatus().mode, 'error');
    assert.equal(sourceStatus().count, 0);
    assert.match(sourceStatus().note, /не обход/i);
  } finally {
    clearProviderCache();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('recognizes challenge pages and disallows non-Avito search URLs', () => {
  assert.throws(() => __test.parsePublicAvitoHtml('<html><body>Подтвердите, что вы не робот</body></html>'), /не обход/i);
  assert.throws(() => __test.validatePublicSearchUrl('https://example.com/'), /avito.ru/);
  assert.throws(() => __test.validatePublicSearchUrl('http://www.avito.ru/all/telefony'), /HTTPS/);
});
