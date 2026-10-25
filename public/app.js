(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#090d12'); tg.setBackgroundColor('#090d12'); } catch {}
  }

  const state = {
    user: null,
    settings: null,
    listings: [],
    benchmarks: {},
    modelOptions: [],
    modelGroups: [],
    source: null,
    refreshedAt: null,
    currentTab: 'deals',
    selectedModels: new Set(),
    selectedStorage: new Set(),
    storageSort: 'discount'
  };
  const $ = id => document.getElementById(id);
  const fmt = value => Number(value || 0).toLocaleString('ru-RU');
  const initData = tg?.initData || '';

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData, ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Ошибка ${response.status}`);
    return body;
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function updateTimestamp(value) {
    if (!value) { $('updated-label').textContent = 'Ожидаем первый опрос'; return; }
    const d = new Date(value);
    $('updated-label').textContent = `Обновлено ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }

  function updateSource() {
    const source = state.source || { mode: 'connecting', label: 'ПОДКЛЮЧЕНИЕ' };
    const chip = $('source-chip');
    chip.classList.toggle('live', source.mode === 'live');
    chip.classList.toggle('error', source.mode === 'error' || source.mode === 'unconfigured');
    chip.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(source.label || 'СТАТУС НЕИЗВЕСТЕН')}</span>`;
    chip.title = source.note || '';
  }

  function renderMetrics(listings) {
    const shownDeals = listings.filter(x => x.isDeal && !x.tooCheap);
    const safeDiscounts = listings.filter(x => x.discountPct !== null && !x.tooCheap && !x.isRisky).map(x => x.discountPct);
    const avg = safeDiscounts.length ? Math.round(safeDiscounts.reduce((a, b) => a + b, 0) / safeDiscounts.length) : null;
    $('metric-total').textContent = listings.length;
    $('metric-deals').textContent = shownDeals.length;
    $('metric-discount').textContent = avg === null ? '—' : `${avg}%`;
  }

  function niceStorage(storage) { return !storage ? 'память не указана' : storage === 1024 ? '1 ТБ' : storage === 2048 ? '2 ТБ' : `${storage} ГБ`; }
  function badgeClass(item) {
    if (item.tooCheap || item.isRisky) return 'risk';
    if (item.status === 'Выгодно') return '';
    return 'neutral';
  }

  function isDirectListingUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
      const url = new URL(value);
      if (!['avito.ru', 'www.avito.ru', 'm.avito.ru'].includes(url.hostname.toLowerCase())) return false;
      const path = decodeURIComponent(url.pathname);
      return /(?:_|\/)\d{7,}(?:\.html)?\/?$/.test(path) || /\/(?:view|item|ads\/view)\/\d{7,}\/?$/.test(path);
    } catch { return false; }
  }

  function renderListings() {
    let listings = [...state.listings];
    const sort = $('sort-select').value;
    if (sort === 'price') listings.sort((a, b) => a.price - b.price);
    else if (sort === 'recent') listings.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    else listings.sort((a, b) => {
      const riskA = (a.tooCheap || a.isRisky) ? 1 : 0;
      const riskB = (b.tooCheap || b.isRisky) ? 1 : 0;
      return riskA - riskB || (b.discountPct ?? -999) - (a.discountPct ?? -999);
    });
    renderMetrics(listings);
    const selectedModels = state.settings?.models || [];
    const selected = !selectedModels.length || (state.modelOptions.length && selectedModels.length === state.modelOptions.length)
      ? 'все модели'
      : `${selectedModels.length} моделей: ${selectedModels.join(', ')}`;
    $('filter-summary').textContent = `${selected} · ${state.settings?.city || 'Вся Россия'} · скидка от ${state.settings?.minDiscountPct ?? 15}%`;
    const container = $('listings-list');
    if (!listings.length) {
      container.innerHTML = '';
      const empty = $('empty-state');
      const title = empty.querySelector('h4');
      const description = empty.querySelector('p');
      const sourceError = state.source?.mode === 'error';
      title.textContent = sourceError ? 'Не удалось получить объявления' : 'Пока ничего не найдено';
      description.textContent = sourceError
        ? (state.source?.note || 'Публичная выдача Avito временно недоступна. Повтори запрос позже или подключи необязательный ReefAPI.')
        : 'По текущим фильтрам нет реальных объявлений с прямыми ссылками. Проверь настройки поиска или укажи публичную ссылку на выдачу Avito в AVITO_PUBLIC_SEARCH_URL.';
      empty.querySelector('[data-go-tab="filters"]')?.classList.toggle('hidden', sourceError);
      empty.classList.remove('hidden');
      return;
    }
    $('empty-state').classList.add('hidden');
    container.innerHTML = listings.map(item => {
      const model = item.model || 'iPhone';
      const status = item.tooCheap ? 'Подозрительно дёшево' : item.status;
      const badge = badgeClass(item);
      const discount = item.discountPct === null ? '—' : `${item.discountPct > 0 ? '−' : '+'}${Math.abs(item.discountPct)}%`;
      const location = item.location || 'Город не указан';
      const battery = item.batteryPct === null ? 'АКБ ?' : `АКБ ${item.batteryPct}%`;
      const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '';
      const warning = (item.riskNotes || []).slice(0, 2).join(' · ');

      const directUrl = isDirectListingUrl(item.url) ? item.url : null;
      // Provider filters out records without a direct Avito listing URL. Keep this guard as defence in depth.
      if (!directUrl) return '';
      const openAction = `<a class="open-link" href="${escapeHtml(directUrl)}" target="_blank" rel="noopener noreferrer">Открыть объявление ↗</a>`;
      return `<article class="listing-card ${item.isDeal ? 'is-deal' : ''} ${(item.tooCheap || item.isRisky) ? 'is-risk' : ''}">
        <div class="listing-top"><span class="model-chip">${escapeHtml(model)} · ${escapeHtml(niceStorage(item.storage))}</span><span class="status-badge ${badge}">${escapeHtml(status)}</span></div>
        <h4>${escapeHtml(item.title || model)}</h4>
        <div class="listing-meta"><span>◉ ${escapeHtml(battery)}</span><span>⌖ ${escapeHtml(location)}</span>${date ? `<span>◷ ${escapeHtml(date)}</span>` : ''}</div>
        <div class="listing-price-row"><div class="listing-price">${fmt(item.price)}<small> ₽</small></div><div class="discount">${discount}<small>к рынку</small></div></div>
        <div class="market-comparison"><span>Ориентир</span><b>${item.marketPrice ? `${fmt(item.marketPrice)} ₽` : 'нет данных'}</b><span>·</span><span>${escapeHtml(item.marketConfidence || 'нет выборки')}</span></div>
        ${warning ? `<div class="risk-line">⚠ ${escapeHtml(warning)}</div>` : ''}
        <div class="listing-bottom"><span class="listing-location">Avito · ${escapeHtml(location)}</span>${openAction}</div>
      </article>`;
    }).join('');
  }

  function renderModelChoices() {
    const groups = state.modelGroups.length ? state.modelGroups : [{ family: 'Модели iPhone', models: state.modelOptions }];
    $('model-choices').innerHTML = groups.map(group => `<section class="model-group"><div class="model-group-title">${escapeHtml(group.family)}</div><div class="model-option-grid">${group.models.map(model => `<button class="choice-chip ${state.selectedModels.has(model) ? 'selected' : ''}" type="button" data-model="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('')}</div></section>`).join('');
    $('model-choices').querySelectorAll('[data-model]').forEach(button => button.addEventListener('click', () => {
      const model = button.dataset.model;
      if (state.selectedModels.has(model)) state.selectedModels.delete(model); else state.selectedModels.add(model);
      button.classList.toggle('selected', state.selectedModels.has(model));
    }));
  }

  function renderStorageChoices() {
    const options = [64, 128, 256, 512, 1024, 2048];
    $('storage-choices').innerHTML = options.map(n => `<button class="storage-chip ${state.selectedStorage.has(n) ? 'selected' : ''}" type="button" data-storage="${n}">${n >= 1024 ? `${n / 1024} ТБ` : n}</button>`).join('');
    $('storage-choices').querySelectorAll('[data-storage]').forEach(button => button.addEventListener('click', () => {
      const n = Number(button.dataset.storage);
      if (state.selectedStorage.has(n)) state.selectedStorage.delete(n); else state.selectedStorage.add(n);
      button.classList.toggle('selected', state.selectedStorage.has(n));
    }));
  }

  function fillSettings() {
    const s = state.settings || {};
    $('city-input').value = s.city || 'Вся Россия';
    $('max-price').value = Number(s.maxPrice ?? 60000);
    $('min-discount').value = Number(s.minDiscountPct ?? 15);
    $('discount-value').textContent = `${Number(s.minDiscountPct ?? 15)}%`;
    $('min-battery').value = String(s.minBatteryPct ?? 80);
    $('private-only').checked = Boolean(s.privateOnly);
    $('notifications-enabled').checked = s.notificationsEnabled !== false;
    state.selectedModels = new Set(s.models?.length ? s.models : state.modelOptions);
    state.selectedStorage = new Set(s.storage?.length ? s.storage : [64, 128, 256, 512, 1024, 2048]);
    renderModelChoices();
    renderStorageChoices();
  }

  function renderMarket() {
    const benchmarks = state.benchmarks || {};
    $('market-table-body').innerHTML = Object.entries(benchmarks).map(([model, sizes]) => {
      const base = sizes['128'] ?? sizes[128] ?? null;
      const extras = Object.entries(sizes).filter(([storage]) => storage !== '128' && Number(storage) !== 128).map(([storage, price]) => `${storage} ГБ — ${fmt(price)} ₽`).join('<br/>');
      const baseStorage = Object.keys(sizes).map(Number).sort((a, b) => a - b)[0];
      const baseLabel = baseStorage ? (baseStorage >= 1024 ? `${baseStorage / 1024} ТБ` : `${baseStorage} ГБ`) : '';
      const allExtras = Object.entries(sizes).filter(([storage]) => Number(storage) !== baseStorage).map(([storage, price]) => `${Number(storage) >= 1024 ? `${Number(storage) / 1024} ТБ` : `${storage} ГБ`} — ${fmt(price)} ₽`).join('<br/>');
      return `<tr><td>${escapeHtml(model)}</td><td class="market-price">${base ? `${fmt(base)} ₽` : baseStorage ? `${baseLabel} · ${fmt(sizes[baseStorage])} ₽` : '—'}</td><td class="muted-price">${allExtras || '—'}</td></tr>`;
    }).join('');
  }

  function setTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${tab}`));
  }

  async function loadBootstrap() {
    try {
      const data = await api('/api/bootstrap');
      state.user = data.user;
      state.settings = data.settings;
      state.modelOptions = data.modelOptions || [];
      state.modelGroups = data.modelGroups || [];
      state.listings = data.listings || [];
      state.benchmarks = data.marketBenchmarks || {};
      state.source = data.source;
      state.refreshedAt = data.refreshedAt;
      fillSettings(); updateSource(); updateTimestamp(data.refreshedAt); renderListings(); renderMarket();
    } catch (error) {
      state.source = { mode: 'error', label: 'ОШИБКА ИСТОЧНИКА', note: error.message };
      updateSource();
      $('listings-list').innerHTML = `<div class="loading-card"><p>${escapeHtml(error.message)}</p><button class="secondary-btn" id="retry-btn">Повторить</button></div>`;
      $('retry-btn')?.addEventListener('click', loadBootstrap);
      showToast('Не удалось загрузить данные');
    }
  }

  async function refreshListings() {
    const btn = $('refresh-btn');
    btn.disabled = true; btn.innerHTML = '<span>↻</span> Проверяем…';
    try {
      const data = await api('/api/refresh', { method: 'POST', body: '{}' });
      state.listings = data.listings || []; state.source = data.source; state.refreshedAt = data.refreshedAt;
      renderListings(); updateSource(); updateTimestamp(data.refreshedAt);
      showToast(data.source?.mode === 'live' ? 'Лента обновлена' : (data.source?.note || 'Источник поиска не готов'));
    } catch (error) {
      state.source = { mode: 'error', label: 'ОШИБКА ИСТОЧНИКА', note: error.message };
      updateSource();
      showToast(error.message);
    }
    finally { btn.disabled = false; btn.innerHTML = '<span>↻</span> Проверить рынок'; }
  }

  async function saveSettings(event) {
    event.preventDefault();
    const payload = {
      city: $('city-input').value.trim() || 'Вся Россия',
      models: [...state.selectedModels],
      storage: [...state.selectedStorage],
      maxPrice: Number($('max-price').value || 0),
      minDiscountPct: Number($('min-discount').value),
      minBatteryPct: Number($('min-battery').value),
      minBatteryFilter: 0,
      privateOnly: $('private-only').checked,
      notificationsEnabled: $('notifications-enabled').checked
    };
    $('save-state').textContent = 'Сохраняю…';
    try {
      const data = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      state.settings = data.settings;
      const refiltered = await api('/api/bootstrap');
      state.listings = refiltered.listings || []; state.source = refiltered.source; state.refreshedAt = refiltered.refreshedAt;
      renderListings(); updateSource(); updateTimestamp(state.refreshedAt);
      $('save-state').textContent = 'Настройки сохранены';
      showToast('Фильтры сохранены'); setTimeout(() => $('save-state').textContent = '', 2500); setTab('deals');
    } catch (error) { $('save-state').textContent = error.message; }
  }

  function resetSettings() {
    state.settings = { city: 'Вся Россия', models: [...state.modelOptions], storage: [64,128,256,512,1024,2048], maxPrice: 250000, minDiscountPct: 15, minBatteryPct: 80, minBatteryFilter: 0, privateOnly: false, notificationsEnabled: true };
    fillSettings(); showToast('Вернул фильтры по умолчанию');
  }

  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
  document.querySelectorAll('[data-go-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.goTab)));
  $('refresh-btn').addEventListener('click', refreshListings);
  $('sort-select').addEventListener('change', renderListings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('reset-btn').addEventListener('click', resetSettings);
  $('min-discount').addEventListener('input', () => $('discount-value').textContent = `${$('min-discount').value}%`);

  loadBootstrap();
})();
