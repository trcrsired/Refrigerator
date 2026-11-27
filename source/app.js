/*
 * Fridge PWA — application logic (readable source).
 * Serves the main page, /help/ and /settings/. Minified into /docs by the build.
 */
(function () {
  'use strict';

  var DAY = 86400000;
  var DB_NAME = 'fridge-pwa';
  var STORE = 'items';

  // SI units only. The kg factor drives the price/kg sort; litres and counts
  // are normalised at 1 L = 1 kg / 1 pcs = 1 kg so they share one scale.
  var UNITS = {
    kg: { label: 'kg', kg: 1 },
    g: { label: 'g', kg: 0.001 },
    mg: { label: 'mg', kg: 0.000001 },
    l: { label: 'L', kg: 1 },
    ml: { label: 'mL', kg: 0.001 },
    pcs: { label: 'pcs', kg: 1 }
  };

  var CURRENCIES = [
    ['USD', '$'], ['EUR', '€'], ['GBP', '£'], ['JPY', '¥'], ['CNY', '¥'],
    ['CAD', '$'], ['AUD', '$'], ['CHF', 'CHF'], ['SEK', 'kr'], ['NOK', 'kr'],
    ['DKK', 'kr'], ['PLN', 'zł'], ['INR', '₹'], ['BRL', 'R$'], ['MXN', '$'],
    ['ZAR', 'R'], ['KRW', '₩'], ['SGD', '$'], ['NZD', '$']
  ];

  var LOCATIONS = ['fridge', 'freezer', 'pantry', 'other'];
  var MAX_SHOTS = 8;

  var $ = function (selector) { return document.querySelector(selector); };
  var el = {
    form: $('#itemForm'),
    name: $('#name'),
    qty: $('#qty'),
    unit: $('#unit'),
    price: $('#price'),
    currency: $('#currency'),
    added: $('#added'),
    expires: $('#expires'),
    submit: $('#submitBtn'),
    cancel: $('#cancelBtn'),
    error: $('#formError'),
    search: $('#search'),
    sort: $('#sort'),
    dateBtn: $('#dateFormatBtn'),
    filters: $('#filters'),
    stats: $('#stats'),
    list: $('#list'),
    alerts: $('#alertsBtn'),
    profileField: $('#profileField'),
    profileSelect: $('#profileSelect'),
    addShot: $('#addShot'),
    shotInput: $('#shotInput'),
    shotPreviews: $('#shotPreviews'),
    lightbox: $('#lightbox'),
    lightboxImg: $('#lightboxImg'),
    lightboxClose: $('#lightboxClose'),
    themeGroup: $('#themeGroup'),
    languageGroup: $('#languageGroup'),
    profileList: $('#profileList'),
    newProfile: $('#newProfile'),
    addProfile: $('#addProfile'),
    exportBtn: $('#exportBtn'),
    importBtn: $('#importBtn'),
    importFile: $('#importFile'),
    shareBtn: $('#shareBtn')
  };

  var state = {
    items: [],
    filter: 'all',
    search: '',
    sort: 'ppu-asc',
    editingId: null,
    dateFormat: 'iso',
    theme: 'system',
    language: 'en',
    profiles: [],
    activeProfile: 'default',
    pendingShots: [],
    lastCheck: 0
  };

  /* ---------- translation ---------- */

  function tr(lang, key, vars) {
    var bundle = globalThis.FRIDGE_I18N || {};
    var dict = bundle[lang] || bundle.en || {};
    var text = dict[key] != null ? dict[key] : ((bundle.en && bundle.en[key]) || key);
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = String(text).split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  function t(key, vars) {
    return tr(state.language, key, vars);
  }

  function applyLanguage() {
    document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (node) {
      node.setAttribute('title', t(node.getAttribute('data-i18n-title')));
    });
    if (el.submit) el.submit.textContent = state.editingId ? t('saveChanges') : t('addItem');
    if (el.alerts && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      el.alerts.textContent = t('enableAlerts');
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#122326' : '#0e8f8a');
  }

  /* ---------- settings storage ---------- */

  function loadLocalSettings() {
    try {
      var settings = JSON.parse(localStorage.getItem('fridge.settings') || '{}');
      state.theme = settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system';
      state.language = settings.language === 'zh' ? 'zh' : 'en';
      state.activeProfile = settings.activeProfile || 'default';
    } catch (e) { /* defaults */ }

    state.dateFormat = localStorage.getItem('fridge.dateFormat') === 'unix' ? 'unix' : 'iso';

    try {
      var profiles = JSON.parse(localStorage.getItem('fridge.profiles') || 'null');
      state.profiles = Array.isArray(profiles) && profiles.length
        ? profiles
        : [{ id: 'default', name: t('fridge') }];
    } catch (e) {
      state.profiles = [{ id: 'default', name: t('fridge') }];
    }
    if (!state.profiles.some(function (p) { return p.id === state.activeProfile; })) {
      state.activeProfile = state.profiles[0].id;
    }
  }

  function saveLocalSettings() {
    localStorage.setItem('fridge.settings', JSON.stringify({
      theme: state.theme,
      language: state.language,
      activeProfile: state.activeProfile
    }));
    localStorage.setItem('fridge.profiles', JSON.stringify(state.profiles));
    localStorage.setItem('fridge.dateFormat', state.dateFormat);
  }

  /* ---------- helpers ---------- */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ISO 8601 strings or Unix timestamps (seconds or milliseconds) -> milliseconds.
  function parseDate(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return null;
    if (/^-?\d+$/.test(value)) {
      var number = Number(value);
      if (!Number.isFinite(number)) return null;
      if (Math.abs(number) <= 1e11) number *= 1000;
      return Number.isFinite(number) ? number : null;
    }
    var parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function formatDate(ms) {
    return state.dateFormat === 'unix'
      ? String(Math.floor(ms / 1000))
      : new Date(ms).toISOString();
  }

  function money(amount, code) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount);
    } catch (e) {
      return amount.toFixed(2) + ' ' + code;
    }
  }

  function pricePerKg(item) {
    var unit = UNITS[item.unit] || UNITS.pcs;
    var kg = Number(item.qty) * unit.kg;
    return kg > 0 ? Number(item.price) / kg : Infinity;
  }

  function expiryInfo(expiresAt) {
    var diff = expiresAt - Date.now();
    if (diff <= 0) {
      var ago = Math.floor(-diff / DAY);
      return {
        text: ago === 0 ? t('expiredToday') : t('expiredDays', { n: ago }),
        cls: 'exp--danger',
        expired: true
      };
    }
    var days = Math.ceil(diff / DAY);
    if (days <= 1) {
      return {
        text: days === 1 ? t('expiresTomorrow') : t('expiresTodayShort'),
        cls: 'exp--warn',
        expired: false
      };
    }
    return { text: t('expiresInDays', { n: days }), cls: days <= 3 ? 'exp--warn' : '', expired: false };
  }

  function locationLabel(loc) {
    return t(LOCATIONS.indexOf(loc) >= 0 ? loc : 'other');
  }

  function safeName(value) {
    return String(value).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
  }

  function appRoot() {
    var meta = document.querySelector('meta[name="app-root"]');
    return new URL(meta ? meta.getAttribute('content') : './', document.baseURI).href;
  }

  function asset(name) {
    return new URL(name, appRoot()).href;
  }

  function toast(message) {
    var node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(function () { node.remove(); }, 3200);
  }

  /* ---------- IndexedDB ---------- */

  var dbPromise;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      var request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('Database blocked')); };
    });
    return dbPromise;
  }

  function withStore(mode, action) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(STORE, mode);
        var store = transaction.objectStore(STORE);
        var request;
        try {
          request = action(store);
        } catch (err) {
          try { transaction.abort(); } catch (e) { /* noop */ }
          return reject(err);
        }
        transaction.oncomplete = function () {
          resolve(request && typeof request.result !== 'undefined' ? request.result : request);
        };
        transaction.onerror = function () { reject(transaction.error); };
        transaction.onabort = function () { reject(transaction.error || new Error('Aborted')); };
      });
    });
  }

  function getAll() {
    return withStore('readonly', function (store) { return store.getAll(); });
  }

  function putItem(item) {
    return withStore('readwrite', function (store) { return store.put(item); });
  }

  function deleteItem(id) {
    return withStore('readwrite', function (store) { return store.delete(id); });
  }

  function clearItems() {
    return withStore('readwrite', function (store) { return store.clear(); });
  }

  /* ---------- rendering ---------- */

  function visibleItems() {
    return state.items.filter(function (item) {
      return (item.profileId || 'default') === state.activeProfile;
    });
  }

  function comparators() {
    return {
      'ppu-asc': function (a, b) { return pricePerKg(a) - pricePerKg(b); },
      'ppu-desc': function (a, b) { return pricePerKg(b) - pricePerKg(a); },
      'expiry': function (a, b) { return a.expiresAt - b.expiresAt; },
      'name': function (a, b) { return a.name.localeCompare(b.name); },
      'newest': function (a, b) { return b.addedAt - a.addedAt; }
    };
  }

  function renderStats(items) {
    if (!el.stats) return;
    var now = Date.now();
    var soon = items.filter(function (item) {
      return item.expiresAt > now && item.expiresAt - now <= 3 * DAY;
    }).length;
    var expired = items.filter(function (item) { return item.expiresAt <= now; }).length;
    el.stats.innerHTML =
      '<div class="stat"><span class="stat__n">' + items.length + '</span><span class="stat__l">' + esc(t('statItems')) + '</span></div>' +
      '<div class="stat stat--warn"><span class="stat__n">' + soon + '</span><span class="stat__l">' + esc(t('statSoon')) + '</span></div>' +
      '<div class="stat stat--danger"><span class="stat__n">' + expired + '</span><span class="stat__l">' + esc(t('statExpired')) + '</span></div>';
  }

  function itemHTML(item) {
    var unit = UNITS[item.unit] || UNITS.pcs;
    var exp = expiryInfo(item.expiresAt);
    var ppu = pricePerKg(item);
    var shots = item.screenshots || [];
    var id = esc(item.id);
    var name = esc(item.name);
    var loc = LOCATIONS.indexOf(item.location) >= 0 ? item.location : 'other';
    var ppuText = Number.isFinite(ppu) ? money(ppu, item.currency) + '/kg' : '—';

    var shotsHTML = shots.length
      ? '<div class="item__shots">' + shots.map(function (src, index) {
          return '<img src="' + esc(src) + '" alt="" data-shot="' + id + '" data-index="' + index + '">';
        }).join('') + '</div>'
      : '';

    return '<article class="item' + (exp.expired ? ' item--expired' : '') + '" data-id="' + id + '">' +
      '<div class="item__top">' +
        '<div><h3 class="item__name">' + name + '</h3>' +
          '<div class="tags">' +
            '<span class="tag tag--' + loc + '">' + esc(locationLabel(loc)) + '</span>' +
            '<span class="tag">' + esc(item.qty) + ' ' + unit.label + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="item__price"><strong>' + money(item.price, item.currency) + '</strong>' +
          '<span title="Normalised to kilograms for sorting">' + esc(ppuText) + '</span>' +
        '</div>' +
      '</div>' +
      shotsHTML +
      '<div class="item__foot">' +
        '<span class="exp ' + exp.cls + '">' + esc(exp.text) + '</span>' +
        '<span class="muted">' + esc(t('addedPrefix')) + esc(formatDate(item.addedAt)) + '</span>' +
        '<span class="item__actions">' +
          '<button class="icon-btn" type="button" data-act="edit" data-id="' + id + '" aria-label="' + esc(t('editLabel')) + '" title="' + esc(t('editLabel')) + '">✎</button>' +
          '<button class="icon-btn" type="button" data-act="share" data-id="' + id + '" aria-label="' + esc(t('shareLabel')) + '" title="' + esc(t('shareLabel')) + '">↗</button>' +
          '<button class="icon-btn icon-btn--danger" type="button" data-act="del" data-id="' + id + '" aria-label="' + esc(t('deleteLabel')) + '" title="' + esc(t('deleteLabel')) + '">✕</button>' +
        '</span>' +
      '</div>' +
    '</article>';
  }

  function render() {
    if (!el.list) return;
    var query = state.search.trim().toLowerCase();
    var items = visibleItems().filter(function (item) {
      return (state.filter === 'all' || item.location === state.filter) &&
        (!query || String(item.name).toLowerCase().indexOf(query) !== -1);
    });
    items.sort(comparators()[state.sort] || comparators()['ppu-asc']);
    renderStats(visibleItems());

    if (!items.length) {
      el.list.innerHTML = '<div class="empty"><strong>' + esc(t('emptyTitle')) + '</strong>' +
        (state.items.length ? esc(t('emptyFiltered')) : esc(t('emptyStorage'))) + '</div>';
      return;
    }
    el.list.innerHTML = items.map(itemHTML).join('');
  }

  async function load() {
    var all;
    try {
      all = await getAll();
    } catch (err) {
      state.items = [];
      if (el.list) {
        el.list.innerHTML = '<div class="empty"><strong>' + esc(t('errStorage')) + '</strong>' + esc(t('errStorageText')) + '</div>';
      }
      renderStats([]);
      return;
    }
    all.forEach(function (item) {
      if (!item.profileId || !Array.isArray(item.screenshots)) {
        item.profileId = item.profileId || 'default';
        item.screenshots = item.screenshots || [];
        putItem(item).catch(function () { /* ignore */ });
      }
    });
    state.items = all;
    render();
  }

  /* ---------- screenshots ---------- */

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        var max = 1280;
        var scale = Math.min(1, max / Math.max(image.width, image.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        var data = canvas.toDataURL('image/webp', 0.8);
        resolve(data.indexOf('data:image/webp') === 0 ? data : canvas.toDataURL('image/jpeg', 0.8));
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('image'));
      };
      image.src = url;
    });
  }

  function renderShotPreviews() {
    if (!el.shotPreviews) return;
    el.shotPreviews.innerHTML = state.pendingShots.map(function (src, index) {
      return '<span class="shot"><img src="' + esc(src) + '" alt="" data-preview="' + index + '">' +
        '<button type="button" data-remove-shot="' + index + '" aria-label="' + esc(t('removeShot')) + '">✕</button></span>';
    }).join('');
  }

  async function addShots(files) {
    for (var i = 0; i < files.length; i++) {
      if (state.pendingShots.length >= MAX_SHOTS) break;
      try {
        state.pendingShots.push(await compressImage(files[i]));
      } catch (e) {
        toast(t('errImage'));
      }
    }
    renderShotPreviews();
  }

  /* ---------- lightbox ---------- */

  function openLightbox(src) {
    if (!el.lightbox) return;
    el.lightboxImg.src = src;
    el.lightbox.classList.remove('is-hidden');
  }

  function closeLightbox() {
    if (!el.lightbox) return;
    el.lightbox.classList.add('is-hidden');
    el.lightboxImg.removeAttribute('src');
  }

  function initLightbox() {
    if (!el.lightbox) return;
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightbox.addEventListener('click', function (event) {
      if (event.target === el.lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeLightbox();
    });
  }

  /* ---------- main page ---------- */

  function fail(message) {
    el.error.textContent = message;
    return false;
  }

  function resetForm() {
    if (!el.form) return;
    el.form.reset();
    var now = Date.now();
    el.added.value = formatDate(now);
    el.expires.value = formatDate(now + 7 * DAY);
    el.currency.value = 'USD';
    el.error.textContent = '';
    state.editingId = null;
    state.pendingShots = [];
    renderShotPreviews();
    el.submit.textContent = t('addItem');
    el.cancel.classList.add('is-hidden');
    renderProfileSelect();
  }

  function startEdit(id) {
    var item = state.items.find(function (entry) { return entry.id === id; });
    if (!item) return;
    state.editingId = item.id;
    el.name.value = item.name;
    el.qty.value = item.qty;
    el.unit.value = item.unit;
    el.price.value = item.price;
    el.currency.value = item.currency;
    el.added.value = formatDate(item.addedAt);
    el.expires.value = formatDate(item.expiresAt);
    el.profileSelect.value = item.profileId || 'default';
    var radio = el.form.querySelector('input[name="location"][value="' + item.location + '"]');
    if (radio) radio.checked = true;
    state.pendingShots = (item.screenshots || []).slice();
    renderShotPreviews();
    el.error.textContent = '';
    el.submit.textContent = t('saveChanges');
    el.cancel.classList.remove('is-hidden');
    el.name.focus();
    el.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function buildCurrencies() {
    if (!el.currency) return;
    el.currency.innerHTML = CURRENCIES.map(function (entry) {
      return '<option value="' + entry[0] + '">' + entry[0] + ' · ' + entry[1] + '</option>';
    }).join('');
    el.currency.value = 'USD';
  }

  function applyDateFormat() {
    if (!el.added || !el.expires || !el.dateBtn) return;
    var unix = state.dateFormat === 'unix';
    el.dateBtn.textContent = unix ? 'UNIX' : 'ISO';
    el.added.placeholder = unix ? '1764240000' : '2026-01-31T12:00:00Z';
    el.expires.placeholder = unix ? '1764844800' : '2026-02-07T12:00:00Z';
  }

  function renderProfileSelect() {
    if (!el.profileSelect) return;
    el.profileSelect.innerHTML = state.profiles.map(function (profile) {
      return '<option value="' + esc(profile.id) + '">' + esc(profile.name) + '</option>';
    }).join('');
    el.profileSelect.value = state.activeProfile;
    if (el.profileField) el.profileField.classList.toggle('is-hidden', state.profiles.length < 2);
  }

  function initMain() {
    el.form.addEventListener('submit', async function (event) {
      event.preventDefault();
      el.error.textContent = '';

      var name = el.name.value.trim();
      var qty = Number(el.qty.value);
      var price = Number(el.price.value);
      var addedAt = parseDate(el.added.value);
      var expiresAt = parseDate(el.expires.value);

      if (!name) return fail(t('errName'));
      if (!(qty > 0)) return fail(t('errQty'));
      if (!(price >= 0)) return fail(t('errPrice'));
      if (addedAt === null) return fail(t('errAdded'));
      if (expiresAt === null) return fail(t('errExpires'));

      var checked = el.form.querySelector('input[name="location"]:checked');
      var old = state.editingId ? state.items.find(function (entry) { return entry.id === state.editingId; }) : null;
      var item = {
        id: old ? old.id : (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'i' + Date.now() + Math.random().toString(36).slice(2)),
        name: name,
        qty: qty,
        unit: el.unit.value,
        price: price,
        currency: el.currency.value,
        addedAt: addedAt,
        expiresAt: expiresAt,
        location: checked ? checked.value : 'fridge',
        profileId: el.profileSelect ? el.profileSelect.value : state.activeProfile,
        screenshots: state.pendingShots.slice(),
        lang: state.language,
        notifiedSoon: old ? !!old.notifiedSoon : false,
        notifiedExpired: old ? !!old.notifiedExpired : false
      };

      try {
        await putItem(item);
      } catch (err) {
        return fail(t(err.name === 'QuotaExceededError' ? 'errQuota' : 'errSave'));
      }
      resetForm();
      await load();
      checkExpiry();
    });

    el.cancel.addEventListener('click', resetForm);

    document.querySelectorAll('[data-stamp]').forEach(function (button) {
      button.addEventListener('click', function () {
        var target = button.getAttribute('data-stamp') === 'added' ? el.added : el.expires;
        var offset = button.getAttribute('data-stamp') === 'expires' ? 7 * DAY : 0;
        target.value = formatDate(Date.now() + offset);
      });
    });

    el.addShot.addEventListener('click', function () { el.shotInput.click(); });
    el.shotInput.addEventListener('change', function () {
      addShots(Array.prototype.slice.call(el.shotInput.files || []));
      el.shotInput.value = '';
    });
    el.shotPreviews.addEventListener('click', function (event) {
      var remove = event.target.closest('button[data-remove-shot]');
      if (remove) {
        state.pendingShots.splice(Number(remove.getAttribute('data-remove-shot')), 1);
        renderShotPreviews();
        return;
      }
      var preview = event.target.closest('img[data-preview]');
      if (preview) openLightbox(state.pendingShots[Number(preview.getAttribute('data-preview'))]);
    });

    el.search.addEventListener('input', function () { state.search = el.search.value; render(); });
    el.sort.addEventListener('change', function () { state.sort = el.sort.value; render(); });

    el.filters.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-filter]');
      if (!button) return;
      state.filter = button.getAttribute('data-filter');
      el.filters.querySelectorAll('button').forEach(function (item) {
        item.classList.toggle('is-active', item === button);
      });
      render();
    });

    el.list.addEventListener('click', function (event) {
      var image = event.target.closest('img[data-shot]');
      if (image) {
        var article = image.closest('.item');
        var item = state.items.find(function (entry) { return entry.id === article.getAttribute('data-id'); });
        if (item) openLightbox((item.screenshots || [])[Number(image.getAttribute('data-index'))]);
        return;
      }
      var button = event.target.closest('button[data-act]');
      if (!button) return;
      var id = button.getAttribute('data-id');
      if (button.getAttribute('data-act') === 'del') {
        if (!window.confirm(t('deleteConfirm'))) return;
        deleteItem(id).then(load).catch(function () { /* ignore */ });
      } else if (button.getAttribute('data-act') === 'share') {
        var shared = state.items.find(function (entry) { return entry.id === id; });
        if (shared) shareItem(shared);
      } else {
        startEdit(id);
      }
    });

    el.dateBtn.addEventListener('click', function () {
      state.dateFormat = state.dateFormat === 'iso' ? 'unix' : 'iso';
      saveLocalSettings();
      [el.added, el.expires].forEach(function (input) {
        var ms = parseDate(input.value);
        if (ms !== null) input.value = formatDate(ms);
      });
      applyDateFormat();
      render();
    });
  }

  /* ---------- notifications ---------- */

  function updateAlertsUI() {
    if (!el.alerts) return;
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      el.alerts.textContent = t('alertsUnavailable');
      el.alerts.disabled = true;
      return;
    }
    el.alerts.textContent = Notification.permission === 'granted' ? t('alertsOn') : t('enableAlerts');
  }

  async function checkExpiry() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (Date.now() - state.lastCheck < 30000) return;
    state.lastCheck = Date.now();

    var registration;
    try { registration = await navigator.serviceWorker.ready; } catch (e) { return; }
    var items;
    try { items = await getAll(); } catch (e) { return; }

    var now = Date.now();
    var changed = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var lang = item.lang || state.language;
      var title = null;
      var body = null;
      var flag = null;

      if (item.expiresAt <= now && !item.notifiedExpired) {
        flag = 'notifiedExpired';
        title = tr(lang, 'notifExpiredTitle', { name: item.name });
        body = tr(lang, 'notifWasDue', { date: new Date(item.expiresAt).toISOString() });
      } else if (item.expiresAt > now && item.expiresAt - now <= DAY && !item.notifiedSoon) {
        flag = 'notifiedSoon';
        title = tr(lang, 'notifSoonTitle', { name: item.name });
        body = tr(lang, 'notifExpires', { date: new Date(item.expiresAt).toISOString() });
      }

      if (flag) {
        try {
          await registration.showNotification(title, {
            body: body,
            tag: 'fridge-' + item.id,
            icon: asset('icon-192.png'),
            badge: asset('icon-96.png'),
            data: { url: appRoot() }
          });
        } catch (e) { /* permission may be absent */ }
        item[flag] = true;
        try { await putItem(item); } catch (e) { /* ignore */ }
        changed = true;
      }
    }
    if (changed) await load();
  }

  function initNotifications() {
    if (el.alerts) {
      el.alerts.addEventListener('click', async function () {
        if (!('Notification' in window)) return;
        var permission = await Notification.requestPermission();
        if (permission === 'granted') {
          try {
            var registration = await navigator.serviceWorker.ready;
            if (registration.periodicSync) {
              await registration.periodicSync.register('expiry-check', { minInterval: 12 * 60 * 60 * 1000 });
            }
          } catch (e) { /* periodic sync is optional */ }
          toast(t('alertsEnabled'));
          checkExpiry();
        }
        updateAlertsUI();
      });
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkExpiry();
    });
    setInterval(checkExpiry, 60000);
  }

  /* ---------- settings page ---------- */

  function profileName() {
    return el.newProfile.value.trim() || t('fridge') + ' ' + (state.profiles.length + 1);
  }

  function renderProfiles() {
    if (!el.profileList) return;
    el.profileList.innerHTML = state.profiles.map(function (profile) {
      var active = profile.id === state.activeProfile;
      return '<div class="profile-row">' +
        '<span class="profile-row__name">' + esc(profile.name) + '</span>' +
        (active ? '<span class="profile-row__active">' + esc(t('active')) + '</span>' : '') +
        '<button class="btn btn--chip" type="button" data-profile="switch" data-id="' + esc(profile.id) + '">' + esc(profile.name) + '</button>' +
        '<button class="btn btn--chip" type="button" data-profile="rename" data-id="' + esc(profile.id) + '">' + esc(t('renameProfile')) + '</button>' +
        '<button class="btn btn--chip" type="button" data-profile="delete" data-id="' + esc(profile.id) + '">' + esc(t('deleteProfile')) + '</button>' +
        '</div>';
    }).join('');
  }

  async function switchProfile(id) {
    state.activeProfile = id;
    saveLocalSettings();
    renderProfiles();
    renderProfileSelect();
    await load();
  }

  async function deleteProfile(id) {
    if (state.profiles.length < 2) return toast(t('lastProfile'));
    if (!window.confirm(t('deleteProfileConfirm'))) return;
    var items = await getAll();
    for (var i = 0; i < items.length; i++) {
      if ((items[i].profileId || 'default') === id) {
        try { await deleteItem(items[i].id); } catch (e) { /* ignore */ }
      }
    }
    state.profiles = state.profiles.filter(function (profile) { return profile.id !== id; });
    if (state.activeProfile === id) state.activeProfile = state.profiles[0].id;
    saveLocalSettings();
    renderProfiles();
    renderProfileSelect();
    await load();
  }

  function backupName() {
    return 'fridge-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  }

  async function buildExport() {
    return {
      app: 'fridge-pwa',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        theme: state.theme,
        language: state.language,
        activeProfile: state.activeProfile,
        dateFormat: state.dateFormat
      },
      profiles: state.profiles.slice(),
      items: await getAll()
    };
  }

  function downloadFile(content, name, type) {
    var url = URL.createObjectURL(new Blob([content], { type: type }));
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function exportData() {
    var text = JSON.stringify(await buildExport(), null, 2);
    var name = backupName();
    if (window.showSaveFilePicker) {
      try {
        var handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Fridge backup', accept: { 'application/json': ['.json'] } }]
        });
        var writable = await handle.createWritable();
        await writable.write(new Blob([text], { type: 'application/json' }));
        await writable.close();
        toast(t('exportDone'));
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    downloadFile(text, name, 'application/json');
    toast(t('exportDone'));
  }

  function pickImportFile() {
    if (window.showOpenFilePicker) {
      return window.showOpenFilePicker({
        types: [{ description: 'Fridge backup', accept: { 'application/json': ['.json'] } }]
      }).then(function (handles) { return handles[0].getFile(); })
        .catch(function (e) {
          if (e.name === 'AbortError') return null;
          throw e;
        });
    }
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = function () { resolve(input.files[0] || null); };
      input.onerror = function () { reject(new Error('file')); };
      input.click();
    });
  }

  async function restoreData(data) {
    if (!data || data.app !== 'fridge-pwa' || !Array.isArray(data.items) || !Array.isArray(data.profiles)) {
      throw new Error(t('importInvalid'));
    }
    if (!window.confirm(t('importConfirm'))) return;

    await clearItems();
    for (var i = 0; i < data.items.length; i++) {
      var item = data.items[i];
      if (!item || !item.id) continue;
      item.screenshots = Array.isArray(item.screenshots) ? item.screenshots : [];
      await putItem(item);
    }

    state.profiles = data.profiles.length ? data.profiles : [{ id: 'default', name: t('fridge') }];
    var settings = data.settings || {};
    state.theme = settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system';
    state.language = settings.language === 'zh' ? 'zh' : 'en';
    state.dateFormat = settings.dateFormat === 'unix' ? 'unix' : 'iso';
    state.activeProfile = state.profiles.some(function (profile) { return profile.id === settings.activeProfile; })
      ? settings.activeProfile
      : state.profiles[0].id;

    saveLocalSettings();
    applyTheme();
    applyLanguage();
    applyDateFormat();
    renderProfiles();
    renderProfileSelect();
    await load();
    checkExpiry();
    toast(t('importDone'));
  }

  async function importFromFile(file) {
    if (!file) return;
    try {
      await restoreData(JSON.parse(await file.text()));
    } catch (e) {
      toast(e.message === t('importInvalid') ? e.message : t('importInvalid'));
    }
  }

  async function shareBackup() {
    var text = JSON.stringify(await buildExport());
    var name = backupName();
    var file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Fridge', text: t('shareHint') });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Fridge', text: t('shareHint') });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    downloadFile(text, name, 'application/json');
    toast(t('exportDone'));
  }

  async function shareItem(item) {
    var text = JSON.stringify({ app: 'fridge-pwa-item', item: item }, null, 2);
    var file = new File([text], safeName(item.name) + '.json', { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: item.name });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    downloadFile(text, safeName(item.name) + '.json', 'application/json');
  }

  function initSettings() {
    var themeRadio = el.themeGroup.querySelector('input[value="' + state.theme + '"]');
    if (themeRadio) themeRadio.checked = true;
    var languageRadio = el.languageGroup.querySelector('input[value="' + state.language + '"]');
    if (languageRadio) languageRadio.checked = true;

    el.themeGroup.addEventListener('change', function () {
      state.theme = el.themeGroup.querySelector('input:checked').value;
      saveLocalSettings();
      applyTheme();
    });

    el.languageGroup.addEventListener('change', async function () {
      state.language = el.languageGroup.querySelector('input:checked').value;
      saveLocalSettings();
      applyLanguage();
      render();
      var items = await getAll();
      for (var i = 0; i < items.length; i++) {
        items[i].lang = state.language;
        try { await putItem(items[i]); } catch (e) { /* ignore */ }
      }
    });

    el.addProfile.addEventListener('click', function () {
      var profile = { id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), name: profileName() };
      state.profiles.push(profile);
      state.activeProfile = profile.id;
      el.newProfile.value = '';
      saveLocalSettings();
      renderProfiles();
      renderProfileSelect();
      load();
    });

    el.profileList.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-profile]');
      if (!button) return;
      var id = button.getAttribute('data-id');
      var action = button.getAttribute('data-profile');
      if (action === 'switch') switchProfile(id);
      else if (action === 'delete') deleteProfile(id);
      else {
        var profile = state.profiles.find(function (entry) { return entry.id === id; });
        if (!profile) return;
        var name = window.prompt(t('renameProfile'), profile.name);
        if (name && name.trim()) {
          profile.name = name.trim();
          saveLocalSettings();
          renderProfiles();
          renderProfileSelect();
        }
      }
    });

    el.exportBtn.addEventListener('click', exportData);
    el.importBtn.addEventListener('click', function () {
      pickImportFile().then(importFromFile).catch(function () { toast(t('importInvalid')); });
    });
    el.importFile.addEventListener('change', function () {
      importFromFile(el.importFile.files[0]);
      el.importFile.value = '';
    });
    el.shareBtn.addEventListener('click', shareBackup);

    renderProfiles();
  }

  /* ---------- boot ---------- */

  async function boot() {
    loadLocalSettings();
    applyTheme();
    applyLanguage();
    buildCurrencies();
    applyDateFormat();
    resetForm();
    renderProfileSelect();
    updateAlertsUI();
    initNotifications();
    initLightbox();
    if (el.form) initMain();
    if (el.profileList) initSettings();
    await load();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register(asset('sw.js'))
          .then(function () { updateAlertsUI(); checkExpiry(); })
          .catch(function () { /* app still works online */ });
      });
    }
  }

  boot();
})();
