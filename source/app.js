/*
 * Fridge PWA — application logic (readable source).
 * Minified / uglified into /docs/app.js by scripts/build.mjs.
 */
(function () {
  'use strict';

  var DAY = 86400000;
  var DB_NAME = 'fridge-pwa';
  var STORE = 'items';

  // SI units only. The kg factor is used for the price/kg sort.
  // Litres use the water approximation 1 L = 1 kg; "pcs" is a count (dimensionless),
  // normalised to 1 so it can share the same price/kg scale.
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

  var $ = function (sel) { return document.querySelector(sel); };
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
    alerts: $('#alertsBtn')
  };

  var state = {
    items: [],
    filter: 'all',
    search: '',
    sort: 'ppu-asc',
    editingId: null,
    dateFormat: localStorage.getItem('fridge.dateFormat') === 'unix' ? 'unix' : 'iso',
    lastCheck: 0
  };

  /* ---------- small helpers ---------- */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Accepts ISO 8601 strings and Unix timestamps (seconds or milliseconds).
  // Returns milliseconds since epoch, or null when unparseable.
  function parseDate(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^-?\d+$/.test(s)) {
      var n = Number(s);
      if (!Number.isFinite(n)) return null;
      if (Math.abs(n) <= 1e11) n *= 1000; // seconds -> milliseconds
      return Number.isFinite(n) ? n : null;
    }
    var t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
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
      return { text: ago === 0 ? 'Expired today' : 'Expired ' + ago + 'd ago', cls: 'exp--danger', expired: true };
    }
    var days = Math.ceil(diff / DAY);
    if (days <= 1) {
      return { text: days === 1 ? 'Expires tomorrow' : 'Expires today', cls: 'exp--warn', expired: false };
    }
    return { text: 'Expires in ' + days + ' days', cls: days <= 3 ? 'exp--warn' : '', expired: false };
  }

  function locationLabel(loc) {
    return loc.charAt(0).toUpperCase() + loc.slice(1);
  }

  /* ---------- IndexedDB (shared with the service worker) ---------- */

  var dbPromise;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('Database blocked')); };
    });
    return dbPromise;
  }

  function withStore(mode, action) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var request;
        try {
          request = action(store);
        } catch (err) {
          try { tx.abort(); } catch (e) { /* noop */ }
          return reject(err);
        }
        tx.oncomplete = function () {
          resolve(request && typeof request.result !== 'undefined' ? request.result : request);
        };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
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

  /* ---------- rendering ---------- */

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
    var now = Date.now();
    var soon = items.filter(function (it) {
      return it.expiresAt > now && it.expiresAt - now <= 3 * DAY;
    }).length;
    var expired = items.filter(function (it) { return it.expiresAt <= now; }).length;
    el.stats.innerHTML =
      '<div class="stat"><span class="stat__n">' + items.length + '</span><span class="stat__l">Items</span></div>' +
      '<div class="stat stat--warn"><span class="stat__n">' + soon + '</span><span class="stat__l">Expiring ≤ 3 days</span></div>' +
      '<div class="stat stat--danger"><span class="stat__n">' + expired + '</span><span class="stat__l">Expired</span></div>';
  }

  function itemHTML(item) {
    var unit = UNITS[item.unit] || UNITS.pcs;
    var exp = expiryInfo(item.expiresAt);
    var ppu = pricePerKg(item);
    var id = esc(item.id);
    var name = esc(item.name);
    var loc = LOCATIONS.indexOf(item.location) >= 0 ? item.location : 'other';
    var ppuText = Number.isFinite(ppu) ? money(ppu, item.currency) + '/kg' : '—';

    return '<article class="item' + (exp.expired ? ' item--expired' : '') + '" data-id="' + id + '">' +
      '<div class="item__top">' +
        '<div><h3 class="item__name">' + name + '</h3>' +
          '<div class="tags">' +
            '<span class="tag tag--' + loc + '">' + locationLabel(loc) + '</span>' +
            '<span class="tag">' + esc(item.qty) + ' ' + unit.label + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="item__price"><strong>' + money(item.price, item.currency) + '</strong>' +
          '<span title="Normalised to kilograms for sorting">' + esc(ppuText) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="item__foot">' +
        '<span class="exp ' + exp.cls + '">' + esc(exp.text) + '</span>' +
        '<span class="muted">Added ' + esc(formatDate(item.addedAt)) + '</span>' +
        '<span class="item__actions">' +
          '<button class="icon-btn" type="button" data-act="edit" data-id="' + id + '" aria-label="Edit ' + name + '" title="Edit">✎</button>' +
          '<button class="icon-btn icon-btn--danger" type="button" data-act="del" data-id="' + id + '" aria-label="Delete ' + name + '" title="Delete">✕</button>' +
        '</span>' +
      '</div>' +
    '</article>';
  }

  function render() {
    var q = state.search.trim().toLowerCase();
    var items = state.items.filter(function (it) {
      var matchesFilter = state.filter === 'all' || it.location === state.filter;
      var matchesSearch = !q || String(it.name).toLowerCase().indexOf(q) !== -1;
      return matchesFilter && matchesSearch;
    });
    items.sort((comparators()[state.sort] || comparators()['ppu-asc']));

    renderStats(state.items);

    if (!items.length) {
      el.list.innerHTML = '<div class="empty"><strong>Nothing here yet</strong>' +
        (state.items.length ? 'Try a different search or filter.' : 'Add your first item above.') + '</div>';
      return;
    }
    el.list.innerHTML = items.map(itemHTML).join('');
  }

  async function load() {
    try {
      state.items = await getAll();
      render();
    } catch (err) {
      state.items = [];
      el.list.innerHTML = '<div class="empty"><strong>Storage unavailable</strong>Items cannot be read from this browser.</div>';
      renderStats([]);
    }
  }

  /* ---------- form ---------- */

  function fail(message) {
    el.error.textContent = message;
    return false;
  }

  function resetForm() {
    el.form.reset();
    var now = Date.now();
    el.added.value = formatDate(now);
    el.expires.value = formatDate(now + 7 * DAY);
    el.error.textContent = '';
    state.editingId = null;
    el.submit.textContent = 'Add item';
    el.cancel.classList.add('is-hidden');
  }

  function startEdit(id) {
    var item = state.items.find(function (it) { return it.id === id; });
    if (!item) return;
    state.editingId = item.id;
    el.name.value = item.name;
    el.qty.value = item.qty;
    el.unit.value = item.unit;
    el.price.value = item.price;
    el.currency.value = item.currency;
    el.added.value = formatDate(item.addedAt);
    el.expires.value = formatDate(item.expiresAt);
    var radio = el.form.querySelector('input[name="location"][value="' + item.location + '"]');
    if (radio) radio.checked = true;
    el.error.textContent = '';
    el.submit.textContent = 'Save changes';
    el.cancel.classList.remove('is-hidden');
    el.name.focus();
    el.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function buildCurrencies() {
    el.currency.innerHTML = CURRENCIES.map(function (c) {
      return '<option value="' + c[0] + '">' + c[0] + ' · ' + c[1] + '</option>';
    }).join('');
    el.currency.value = 'USD';
  }

  function applyDateFormat() {
    var unix = state.dateFormat === 'unix';
    el.dateBtn.textContent = unix ? 'UNIX' : 'ISO';
    el.added.placeholder = unix ? '1764240000' : '2026-01-31T12:00:00Z';
    el.expires.placeholder = unix ? '1764844800' : '2026-02-07T12:00:00Z';
  }

  el.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    el.error.textContent = '';

    var name = el.name.value.trim();
    var qty = Number(el.qty.value);
    var price = Number(el.price.value);
    var addedAt = parseDate(el.added.value);
    var expiresAt = parseDate(el.expires.value);

    if (!name) return fail('Enter a name.');
    if (!(qty > 0)) return fail('Amount must be greater than zero.');
    if (!(price >= 0)) return fail('Price cannot be negative.');
    if (addedAt === null) return fail('Added must be an ISO 8601 date or a Unix timestamp.');
    if (expiresAt === null) return fail('Expires must be an ISO 8601 date or a Unix timestamp.');

    var checked = el.form.querySelector('input[name="location"]:checked');
    var old = state.editingId ? state.items.find(function (it) { return it.id === state.editingId; }) : null;
    var item = {
      id: old ? old.id : (window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : 'i' + Date.now() + Math.random().toString(36).slice(2)),
      name: name,
      qty: qty,
      unit: el.unit.value,
      price: price,
      currency: el.currency.value,
      addedAt: addedAt,
      expiresAt: expiresAt,
      location: checked ? checked.value : 'fridge',
      notifiedSoon: old ? !!old.notifiedSoon : false,
      notifiedExpired: old ? !!old.notifiedExpired : false
    };

    try {
      await putItem(item);
    } catch (err) {
      return fail('Could not save this item. Is storage available?');
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

  el.search.addEventListener('input', function () {
    state.search = el.search.value;
    render();
  });

  el.sort.addEventListener('change', function () {
    state.sort = el.sort.value;
    render();
  });

  el.filters.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.getAttribute('data-filter');
    el.filters.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('is-active', b === button);
    });
    render();
  });

  el.list.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var id = button.getAttribute('data-id');
    if (button.getAttribute('data-act') === 'del') {
      if (!window.confirm('Delete this item?')) return;
      deleteItem(id).then(load).catch(function () { /* ignore */ });
    } else {
      startEdit(id);
    }
  });

  el.dateBtn.addEventListener('click', function () {
    // Switch the display format first, then re-express the two date fields in it.
    state.dateFormat = state.dateFormat === 'iso' ? 'unix' : 'iso';
    localStorage.setItem('fridge.dateFormat', state.dateFormat);
    [el.added, el.expires].forEach(function (input) {
      var ms = parseDate(input.value);
      if (ms !== null) input.value = formatDate(ms);
    });
    applyDateFormat();
    render();
  });

  /* ---------- notifications ---------- */

  function updateAlertsUI() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      el.alerts.textContent = 'Alerts unavailable';
      el.alerts.disabled = true;
      return;
    }
    el.alerts.textContent = Notification.permission === 'granted' ? 'Alerts on' : 'Enable alerts';
  }

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
      checkExpiry();
    }
    updateAlertsUI();
  });

  async function checkExpiry() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (Date.now() - state.lastCheck < 30000) return; // avoid duplicate bursts
    state.lastCheck = Date.now();

    var registration;
    try { registration = await navigator.serviceWorker.ready; } catch (e) { return; }
    var items;
    try { items = await getAll(); } catch (e) { return; }

    var now = Date.now();
    var changed = false;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var title = null;
      var body = null;
      var flag = null;

      if (item.expiresAt <= now && !item.notifiedExpired) {
        flag = 'notifiedExpired';
        title = 'Expired: ' + item.name;
        body = 'Was due ' + formatDate(item.expiresAt);
      } else if (item.expiresAt > now && item.expiresAt - now <= DAY && !item.notifiedSoon) {
        flag = 'notifiedSoon';
        title = 'Expiring soon: ' + item.name;
        body = 'Expires ' + formatDate(item.expiresAt);
      }

      if (flag) {
        try {
          await registration.showNotification(title, {
            body: body,
            tag: 'fridge-' + item.id,
            icon: 'icon-192.png',
            badge: 'icon-96.png',
            data: { url: './' }
          });
        } catch (e) { /* notification failed; keep the flag so we do not retry forever */ }
        item[flag] = true;
        try { await putItem(item); } catch (e) { /* ignore */ }
        changed = true;
      }
    }
    if (changed) await load();
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkExpiry();
  });
  setInterval(checkExpiry, 60000);

  /* ---------- boot ---------- */

  buildCurrencies();
  applyDateFormat();
  resetForm();
  updateAlertsUI();
  load();

  if (new URLSearchParams(window.location.search).get('add') === '1') {
    el.name.focus();
    el.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js')
        .then(function () { updateAlertsUI(); checkExpiry(); })
        .catch(function () { /* app still works online */ });
    });
  }
})();
