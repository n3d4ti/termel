'use strict';

// ---------------------------------------------------------------------------
// Konstansok, állapot
// ---------------------------------------------------------------------------

const STORE_KEY = 'mennyittermel.v1';
const HU_BOUNDS = { latMin: 45.7, latMax: 48.6, lonMin: 16.1, lonMax: 22.95 };
const DIRS = [['É', 0], ['ÉK', 45], ['K', 90], ['DK', 135], ['D', 180], ['DNy', 225], ['Ny', 270], ['ÉNy', 315]];
const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OM_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

const DEFAULTS = {
  lat: 47.4979,
  lon: 19.0402,
  arrays: [{ name: 'Tető', kwp: 9, tilt: 35, az: 180 }],
  invKw: 12,
  invEff: 97,
  loss: 10,
  gamma: -0.35,
  days: 16,
};

const WEATHER = {
  0: ['☀️', 'Derült'], 1: ['🌤️', 'Túlnyomóan derült'], 2: ['⛅', 'Részben felhős'], 3: ['☁️', 'Borult'],
  45: ['🌫️', 'Köd'], 48: ['🌫️', 'Zúzmarás köd'],
  51: ['🌦️', 'Gyenge szitálás'], 53: ['🌦️', 'Szitálás'], 55: ['🌦️', 'Erős szitálás'],
  56: ['🌧️', 'Ónos szitálás'], 57: ['🌧️', 'Ónos szitálás'],
  61: ['🌧️', 'Gyenge eső'], 63: ['🌧️', 'Eső'], 65: ['🌧️', 'Erős eső'],
  66: ['🌧️', 'Ónos eső'], 67: ['🌧️', 'Ónos eső'],
  71: ['🌨️', 'Gyenge havazás'], 73: ['🌨️', 'Havazás'], 75: ['🌨️', 'Erős havazás'], 77: ['🌨️', 'Hószemcse'],
  80: ['🌦️', 'Gyenge zápor'], 81: ['🌦️', 'Zápor'], 82: ['⛈️', 'Heves zápor'],
  85: ['🌨️', 'Hózápor'], 86: ['🌨️', 'Erős hózápor'],
  95: ['⛈️', 'Zivatar'], 96: ['⛈️', 'Zivatar jégesővel'], 99: ['⛈️', 'Zivatar jégesővel'],
};

const $ = (sel) => document.querySelector(sel);
const fmt = (v, d = 1) => Number(v).toLocaleString('hu-HU', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let state = loadState();
let map = null;
let marker = null;
let dailyChart = null;
let hourlyChart = null;
let lastResult = null;
let selectedDay = null;

// ---------------------------------------------------------------------------
// Állapot mentése / betöltése (localStorage + megosztható URL hash)
// ---------------------------------------------------------------------------

function loadState() {
  let s = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) s = { ...s, ...saved };
  } catch { /* nincs tárolt állapot */ }
  const fromHash = parseHash(location.hash);
  if (fromHash) s = { ...s, ...fromHash };
  return s;
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* privát mód */ }
}

function stateToHash() {
  const p = new URLSearchParams({
    lat: state.lat, lon: state.lon,
    a: state.arrays.map((a) => `${a.kwp}:${a.tilt}:${a.az}`).join(','),
    inv: state.invKw, eff: state.invEff, loss: state.loss, g: state.gamma, d: state.days,
  });
  return '#' + p.toString();
}

function parseHash(hash) {
  if (!hash || hash.length < 2) return null;
  const p = new URLSearchParams(hash.slice(1));
  const out = {};
  const num = (k) => (p.has(k) && Number.isFinite(+p.get(k)) ? +p.get(k) : undefined);
  if (num('lat') !== undefined && num('lon') !== undefined) { out.lat = num('lat'); out.lon = num('lon'); }
  if (p.get('a')) {
    const arrays = p.get('a').split(',').map((x, i) => {
      const [kwp, tilt, az] = x.split(':').map(Number);
      return { name: `Tetőfelület ${i + 1}`, kwp, tilt, az };
    }).filter((a) => a.kwp > 0 && Number.isFinite(a.tilt) && Number.isFinite(a.az));
    if (arrays.length) out.arrays = arrays;
  }
  for (const [k, key] of [['inv', 'invKw'], ['eff', 'invEff'], ['loss', 'loss'], ['g', 'gamma'], ['d', 'days']]) {
    if (num(k) !== undefined) out[key] = num(k);
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Helyszín: koordináta / Google Maps URL értelmezése, geokódolás
// ---------------------------------------------------------------------------

function parseLocation(raw) {
  let s = raw.trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* marad az eredeti */ }
  s = s.replace(/\+/g, ' ');

  if (/(goo\.gl|maps\.app\.goo)/i.test(s)) return { error: 'short' };

  const n = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp('!3d' + n + '!4d' + n),                                       // kijelölt hely a Google Maps linkben
    new RegExp('[?&](?:q|query|ll|sll|center|destination|daddr)=(?:loc:)?\\s*' + n + '\\s*,\\s*' + n),
    new RegExp('@' + n + ',' + n),                                           // térkép közepe
    new RegExp('/(?:place|search|dir)/' + n + ',\\s*' + n),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return validLatLon(+m[1], +m[2]);
  }

  // Fok-perc-másodperc, pl. 47°29'52.4"N 19°02'24.7"E
  const dms = s.match(/(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NSÉD])[\s,]*(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EWKNy]+)/i);
  if (dms) {
    let lat = +dms[1] + dms[2] / 60 + dms[3] / 3600;
    let lon = +dms[5] + dms[6] / 60 + dms[7] / 3600;
    if (/^[SD]$/i.test(dms[4])) lat = -lat;
    if (/^(W|Ny)$/i.test(dms[8])) lon = -lon;
    return validLatLon(lat, lon);
  }

  // Tizedes vesszős magyar írásmód szóközzel elválasztva: "47,4979 19,0402"
  let m = s.match(/^\s*(-?\d{1,2}[.,]\d+)\s*[;\s]\s*(-?\d{1,3}[.,]\d+)\s*$/);
  if (m) return validLatLon(+m[1].replace(',', '.'), +m[2].replace(',', '.'));

  // Bárhol a szövegben: "47.4979, 19.0402"
  m = s.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (m) return validLatLon(+m[1], +m[2]);

  return null;
}

function validLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function inHungary(lat, lon) {
  return lat >= HU_BOUNDS.latMin && lat <= HU_BOUNDS.latMax && lon >= HU_BOUNDS.lonMin && lon <= HU_BOUNDS.lonMax;
}

async function geocode(name) {
  const p = new URLSearchParams({ name, count: 6, language: 'hu', format: 'json', countryCode: 'HU' });
  const r = await fetch(`${OM_GEOCODE}?${p}`);
  if (!r.ok) throw new Error(`Geokódolási hiba (HTTP ${r.status})`);
  return (await r.json()).results || [];
}

function setLocation(lat, lon, { label = '', pan = true } = {}) {
  state.lat = Math.round(lat * 1e5) / 1e5;
  state.lon = Math.round(lon * 1e5) / 1e5;
  $('#lat').value = state.lat;
  $('#lon').value = state.lon;
  if (marker) marker.setLatLng([state.lat, state.lon]);
  if (map && pan) map.setView([state.lat, state.lon], Math.max(map.getZoom(), 11));
  const status = $('#locStatus');
  if (inHungary(state.lat, state.lon)) {
    status.className = 'muted';
    status.textContent = label ? `✓ ${label}` : '✓ Helyszín beállítva';
  } else {
    status.className = 'warn';
    status.textContent = '⚠ A pont Magyarországon kívül esik';
  }
  saveState();
}

async function handleLocationInput(e) {
  e.preventDefault();
  const text = $('#locInput').value;
  const box = $('#locResults');
  box.innerHTML = '';
  if (!text.trim()) return;

  const parsed = parseLocation(text);
  if (parsed && parsed.error === 'short') {
    box.innerHTML = '<p class="hint warn">A rövidített Google Maps linket (maps.app.goo.gl) a böngésző nem tudja feloldani. Nyisd meg a linket, és a címsorban megjelenő hosszú URL-t másold be – vagy jobb klikk a térképen a helyre, és másold ki a koordinátákat.</p>';
    return;
  }
  if (parsed) {
    setLocation(parsed.lat, parsed.lon, { label: `${fmt(parsed.lat, 5)}, ${fmt(parsed.lon, 5)}` });
    calculate();
    return;
  }

  // Nem koordináta → településnév keresése
  try {
    const results = await geocode(text.trim());
    if (!results.length) {
      box.innerHTML = '<p class="hint warn">Nem találtam ilyen helyet. Adj meg koordinátát, Google Maps linket vagy kattints a térképre.</p>';
      return;
    }
    const pick = (r) => {
      box.innerHTML = '';
      setLocation(r.latitude, r.longitude, { label: placeLabel(r) });
      calculate();
    };
    if (results.length === 1) return pick(results[0]);
    results.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = `📍 ${placeLabel(r)}`;
      b.onclick = () => pick(r);
      box.appendChild(b);
    });
  } catch (err) {
    box.innerHTML = `<p class="hint warn">${esc(err.message)}</p>`;
  }
}

function placeLabel(r) {
  return [r.name, r.admin2, r.admin1].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
}

function initMap() {
  if (typeof L === 'undefined') {
    $('#map').innerHTML = '<p class="hint" style="padding:12px">A térkép nem töltődött be – a koordinátákat kézzel is megadhatod.</p>';
    return;
  }
  map = L.map('map', { scrollWheelZoom: false }).setView([state.lat, state.lon], 11);
  // A tile.openstreetmap.org és a CARTO Referer nélkül (file://) letiltja a kéréseket, az Esri nem
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Térkép: © <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © OpenStreetMap',
  }).addTo(map);
  marker = L.marker([state.lat, state.lon], { draggable: true }).addTo(map);
  marker.on('dragend', () => {
    const { lat, lng } = marker.getLatLng();
    setLocation(lat, lng, { pan: false });
  });
  map.on('click', (e) => setLocation(e.latlng.lat, e.latlng.lng, { pan: false }));
}

// ---------------------------------------------------------------------------
// Napelem mezők szerkesztője
// ---------------------------------------------------------------------------

function compassSvg(az) {
  return `<svg class="compass" viewBox="0 0 64 64" aria-hidden="true">
    <circle class="ring" cx="32" cy="32" r="30"/>
    <text x="32" y="9">É</text><text x="32" y="56">D</text><text x="56" y="33">K</text><text x="8" y="33">Ny</text>
    <g class="needle-g" transform="rotate(${az} 32 32)"><path class="needle" d="M32 14 L37 34 L32 30 L27 34 Z"/></g>
  </svg>`;
}

function renderArrays() {
  const box = $('#arrays');
  box.innerHTML = '';
  state.arrays.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'array-card';
    el.innerHTML = `
      <div class="array-head">
        <input class="a-name" type="text" value="${esc(a.name)}" aria-label="Tetőfelület neve">
        ${state.arrays.length > 1 ? '<button type="button" class="icon-btn a-del" title="Törlés">✕</button>' : ''}
      </div>
      <div class="array-body">
        <div class="grid3">
          <label>Teljesítmény (kWp)<input class="a-kwp" type="number" min="0.1" step="0.1" value="${a.kwp}"></label>
          <label>Dőlésszög (°)<input class="a-tilt" type="number" min="0" max="90" step="1" value="${a.tilt}"></label>
          <label>Tájolás (°)<input class="a-az" type="number" min="0" max="359" step="1" value="${a.az}"></label>
        </div>
        ${compassSvg(a.az)}
      </div>
      <div class="tilt-row">0°<input class="a-tilt-range" type="range" min="0" max="90" step="1" value="${a.tilt}" aria-label="Dőlésszög">90°</div>
      <div class="dir-picker">${DIRS.map(([n, d]) => `<button type="button" data-az="${d}" class="${a.az === d ? 'on' : ''}" title="${d}°">${n}</button>`).join('')}</div>`;

    const q = (s) => el.querySelector(s);
    const syncAz = () => {
      q('.needle-g').setAttribute('transform', `rotate(${a.az} 32 32)`);
      el.querySelectorAll('.dir-picker button').forEach((b) => b.classList.toggle('on', +b.dataset.az === a.az));
    };
    q('.a-name').oninput = (e) => { a.name = e.target.value; saveState(); };
    q('.a-kwp').oninput = (e) => { a.kwp = +e.target.value; saveState(); };
    q('.a-tilt').oninput = (e) => { a.tilt = clamp(+e.target.value, 0, 90); q('.a-tilt-range').value = a.tilt; saveState(); };
    q('.a-tilt-range').oninput = (e) => { a.tilt = +e.target.value; q('.a-tilt').value = a.tilt; saveState(); };
    q('.a-az').oninput = (e) => { a.az = ((+e.target.value % 360) + 360) % 360; syncAz(); saveState(); };
    el.querySelectorAll('.dir-picker button').forEach((b) => {
      b.onclick = () => { a.az = +b.dataset.az; q('.a-az').value = a.az; syncAz(); saveState(); };
    });
    const del = q('.a-del');
    if (del) del.onclick = () => { state.arrays.splice(i, 1); saveState(); renderArrays(); };
    box.appendChild(el);
  });
}

function bindSettings() {
  for (const id of ['invKw', 'invEff', 'loss', 'gamma', 'days']) {
    const el = $('#' + id);
    el.value = state[id];
    el.addEventListener('input', () => { state[id] = +el.value; saveState(); });
  }
  $('#lat').value = state.lat;
  $('#lon').value = state.lon;
  const onCoordInput = () => {
    const v = validLatLon(+$('#lat').value, +$('#lon').value);
    if (v) setLocation(v.lat, v.lon);
  };
  $('#lat').addEventListener('change', onCoordInput);
  $('#lon').addEventListener('change', onCoordInput);

  $('#addArray').onclick = () => {
    const n = state.arrays.length + 1;
    state.arrays.push({ name: `Tetőfelület ${n}`, kwp: 3, tilt: 30, az: n % 2 ? 90 : 270 });
    saveState();
    renderArrays();
  };
  $('#locForm').addEventListener('submit', handleLocationInput);
  $('#calcBtn').onclick = calculate;
  $('#csvBtn').onclick = downloadCsv;
  $('#geoBtn').onclick = () => {
    if (!navigator.geolocation) return showMsg('A böngésző nem támogatja a helymeghatározást.', 'error');
    $('#locStatus').textContent = 'Helymeghatározás…';
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocation(pos.coords.latitude, pos.coords.longitude, { label: 'Saját helyzet' }); calculate(); },
      (err) => { $('#locStatus').textContent = ''; showMsg(`Helymeghatározás sikertelen: ${err.message}`, 'error'); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
}

function validateConfig() {
  const errs = [];
  if (!validLatLon(state.lat, state.lon)) errs.push('Érvénytelen koordináta.');
  if (!state.arrays.length) errs.push('Legalább egy tetőfelület szükséges.');
  state.arrays.forEach((a) => {
    if (!(a.kwp > 0)) errs.push(`„${a.name}”: a teljesítmény legyen 0-nál nagyobb.`);
    if (!(a.tilt >= 0 && a.tilt <= 90)) errs.push(`„${a.name}”: a dőlésszög 0–90° között legyen.`);
    if (!(a.az >= 0 && a.az < 360)) errs.push(`„${a.name}”: a tájolás 0–359° között legyen.`);
  });
  if (!(state.invKw > 0)) errs.push('Az inverter teljesítménye legyen 0-nál nagyobb.');
  if (!(state.invEff > 50 && state.invEff <= 100)) errs.push('Az inverter hatásfoka 50–100% között legyen.');
  if (!(state.loss >= 0 && state.loss < 100)) errs.push('A veszteség 0–100% között legyen.');
  return errs;
}

// ---------------------------------------------------------------------------
// Előrejelzés lekérése és termelés szimuláció
// ---------------------------------------------------------------------------

async function fetchForecast(lat, lon, tilt, az, days) {
  const p = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'global_tilted_irradiance,temperature_2m,wind_speed_10m,cloud_cover',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunshine_duration',
    timezone: 'Europe/Budapest',
    forecast_days: days,
    tilt,
    azimuth: az - 180, // Open-Meteo: 0 = dél, -90 = kelet, 90 = nyugat
    wind_speed_unit: 'ms',
  });
  const r = await fetch(`${OM_FORECAST}?${p}`);
  if (!r.ok) {
    let reason = `HTTP ${r.status}`;
    try { reason = (await r.json()).reason || reason; } catch { /* nem JSON */ }
    throw new Error(`Időjárás-előrejelzés lekérése sikertelen: ${reason}`);
  }
  return r.json();
}

// Egy óra (az előző órára átlagolt sugárzás) teljesítménye kW-ban
function simulateHour(cfg, inputs) {
  let dc = 0;
  for (const { kwp, gti, temp, wind } of inputs) {
    if (!(gti > 0)) continue;
    const tCell = temp + gti / (25 + 6.84 * Math.max(0, wind)); // Faiman modell
    const tempFactor = 1 + (cfg.gamma / 100) * (tCell - 25);
    dc += Math.max(0, kwp * (gti / 1000) * tempFactor * (1 - cfg.loss / 100));
  }
  const acUnclipped = dc * (cfg.invEff / 100);
  const ac = Math.min(acUnclipped, cfg.invKw);
  return { dc, ac, clip: acUnclipped - ac, acUnclipped };
}

function simulate(cfg, responses, uniqueKey) {
  const base = responses[0];
  const times = base.hourly.time;
  const hours = [];

  for (let i = 1; i < times.length; i++) {
    let missing = false;
    const inputs = cfg.arrays.map((a) => {
      const h = responses[uniqueKey(a)].hourly;
      const gti = h.global_tilted_irradiance[i];
      const temp = h.temperature_2m[i];
      if (gti == null || temp == null) missing = true;
      return { kwp: a.kwp, gti: gti ?? 0, temp: temp ?? 15, wind: h.wind_speed_10m[i] ?? 1 };
    });
    // Az i. időbélyeg az előző órára vonatkozik → az óra kezdete times[i-1]
    const start = times[i - 1];
    hours.push({
      start,
      date: start.slice(0, 10),
      hour: +start.slice(11, 13),
      missing,
      cloud: base.hourly.cloud_cover[i],
      ...simulateHour(cfg, inputs),
    });
  }

  const d = base.daily;
  const nowLocal = new Date(Date.now() + base.utc_offset_seconds * 1000).toISOString().slice(0, 16);
  const days = d.time.map((date, idx) => {
    const hs = hours.filter((h) => h.date === date);
    const sum = (k, arr = hs) => arr.reduce((s, h) => s + h[k], 0);
    const remaining = hs.filter((h) => h.start >= nowLocal.slice(0, 13) + ':00');
    return {
      date,
      idx,
      hours: hs,
      energy: sum('ac'),
      remaining: sum('ac', remaining),
      clip: sum('clip'),
      peak: Math.max(0, ...hs.map((h) => h.ac)),
      missing: hs.some((h) => h.missing),
      code: d.weather_code[idx],
      tmax: d.temperature_2m_max[idx],
      tmin: d.temperature_2m_min[idx],
      sunshine: (d.sunshine_duration[idx] ?? 0) / 3600,
    };
  });

  return { days, nowLocal, generated: new Date() };
}

async function calculate() {
  const errs = validateConfig();
  if (errs.length) return showMsg(errs.join('<br>'), 'error', true);

  const cfg = structuredClone(state);
  const btn = $('#calcBtn');
  btn.disabled = true;
  showMsg('Előrejelzés lekérése…', 'loading');

  try {
    // Azonos dőlés/tájolású mezőkhöz elég egy lekérés
    const key = (a) => `${a.tilt}|${a.az}`;
    const uniq = [...new Map(cfg.arrays.map((a) => [key(a), a])).values()];
    const fetched = await Promise.all(uniq.map((a) => fetchForecast(cfg.lat, cfg.lon, a.tilt, a.az, cfg.days)));
    const byKey = Object.fromEntries(uniq.map((a, i) => [key(a), fetched[i]]));
    const responses = Object.assign([fetched[0]], byKey);

    lastResult = simulate(cfg, responses, key);
    lastResult.cfg = cfg;
    history.replaceState(null, '', stateToHash());
    hideMsg();

    const today = lastResult.days[0];
    selectedDay = (today && today.remaining > 0.05 ? today : lastResult.days[1] || today).date;
    render();
  } catch (err) {
    console.error(err);
    showMsg(esc(err.message || String(err)), 'error', true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Megjelenítés
// ---------------------------------------------------------------------------

function showMsg(html, kind = '', isHtml = false) {
  const el = $('#msg');
  el.className = 'msg ' + kind;
  el[isHtml ? 'innerHTML' : 'textContent'] = html;
  el.hidden = false;
}
function hideMsg() { $('#msg').hidden = true; }

function reliability(idx) {
  if (idx <= 2) return { cls: 'r-high', text: 'Jó', alpha: 1 };
  if (idx <= 6) return { cls: 'r-mid', text: 'Közepes', alpha: 0.7 };
  return { cls: 'r-low', text: 'Tájékoztató', alpha: 0.4 };
}

function dayName(date, short = false) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('hu-HU', short
    ? { month: 'numeric', day: 'numeric', weekday: 'short' }
    : { month: 'long', day: 'numeric', weekday: 'long' });
}

function relDayLabel(day) {
  if (day.idx === 0) return 'Ma';
  if (day.idx === 1) return 'Holnap';
  return dayName(day.date, true);
}

function render() {
  if (!lastResult) return;
  renderKpis();
  renderDailyChart();
  renderTable();
  renderHourly();
  $('#csvBtn').disabled = false;
}

function renderKpis() {
  const { days, cfg } = lastResult;
  const totalKwp = cfg.arrays.reduce((s, a) => s + a.kwp, 0);
  const valid = days.filter((d) => !d.missing);
  const sum = (arr) => arr.reduce((s, d) => s + d.energy, 0);
  const week = days.slice(0, 7);
  const total = sum(valid);
  const clip = valid.reduce((s, d) => s + d.clip, 0);
  const best = valid.reduce((b, d) => (d.energy > (b?.energy ?? -1) ? d : b), null);
  const today = days[0];
  const tomorrow = days[1];

  const kpi = (label, value, unit, sub = '', hero = false) => `
    <div class="kpi${hero ? ' hero' : ''}">
      <div class="label">${label}</div>
      <div class="value">${value}<small>${unit}</small></div>
      <div class="sub">${sub}</div>
    </div>`;

  $('#kpis').innerHTML = [
    today && kpi('Ma', fmt(today.energy), 'kWh', `még várható: ${fmt(today.remaining)} kWh`),
    tomorrow && kpi('Holnap', fmt(tomorrow.energy), 'kWh', `${(WEATHER[tomorrow.code] || ['', ''])[1]} · ${fmt(tomorrow.energy / totalKwp, 2)} kWh/kWp`, true),
    kpi('Következő 7 nap', fmt(sum(week), 0), 'kWh', `átlag ${fmt(sum(week) / week.length)} kWh/nap`),
    kpi(`Teljes időszak (${valid.length} nap)`, fmt(total, 0), 'kWh', `átlag ${fmt(total / Math.max(1, valid.length))} kWh/nap`),
    best && kpi('Legjobb nap', fmt(best.energy), 'kWh', dayName(best.date, true)),
    kpi('Inverter levágás', fmt(clip), 'kWh', clip > 0.05 ? `${fmt((clip / (total + clip)) * 100)}% veszteség` : 'nincs jelentős'),
  ].filter(Boolean).join('');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(color, a) {
  const hex = color.replace('#', '');
  if (hex.length !== 6) return color;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

function chartDefaults() {
  if (typeof Chart === 'undefined') return false;
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--border');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  return true;
}

function renderDailyChart() {
  if (!chartDefaults()) return;
  const { days } = lastResult;
  const accent = cssVar('--accent');
  const accentStrong = cssVar('--accent-strong');
  const bg = days.map((d) => withAlpha(d.date === selectedDay ? accentStrong : accent, reliability(d.idx).alpha));

  const data = {
    labels: days.map(relDayLabel),
    datasets: [{
      label: 'Várható termelés (kWh)',
      data: days.map((d) => +d.energy.toFixed(2)),
      backgroundColor: bg,
      borderRadius: 5,
    }],
  };

  if (dailyChart) {
    dailyChart.data = data;
    dailyChart.update();
    return;
  }
  dailyChart = new Chart($('#dailyChart'), {
    type: 'bar',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => dayName(lastResult.days[items[0].dataIndex].date),
            label: (item) => {
              const d = lastResult.days[item.dataIndex];
              const lines = [`Termelés: ${fmt(d.energy)} kWh`, `Csúcs: ${fmt(d.peak, 2)} kW`];
              if (d.clip > 0.05) lines.push(`Levágás: ${fmt(d.clip)} kWh`);
              lines.push(`${(WEATHER[d.code] || ['', '–'])[1]}, ${fmt(d.tmin, 0)}…${fmt(d.tmax, 0)} °C`);
              return lines;
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'kWh' } },
        x: { grid: { display: false } },
      },
      onClick: (_e, els) => {
        if (els.length) selectDay(lastResult.days[els[0].index].date);
      },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
    },
  });
}

function selectDay(date) {
  selectedDay = date;
  renderDailyChart();
  renderHourly();
  document.querySelectorAll('#dayTable tbody tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.date === date));
}

function renderHourly() {
  if (!chartDefaults()) return;
  const day = lastResult.days.find((d) => d.date === selectedDay);
  if (!day) return;
  const { cfg } = lastResult;
  // Csak a nappali órák (+1 óra keret) jelenjenek meg
  const lit = day.hours.map((h, i) => (h.acUnclipped > 0.001 ? i : -1)).filter((i) => i >= 0);
  const from = lit.length ? Math.max(0, lit[0] - 1) : 6;
  const to = lit.length ? Math.min(day.hours.length - 1, lit[lit.length - 1] + 1) : 18;
  const hs = day.hours.slice(from, to + 1);
  const hasClip = hs.some((h) => h.clip > 0.001);

  $('#hourlyTitle').textContent = `Órás bontás – ${dayName(day.date)} (${fmt(day.energy)} kWh)`;

  const accentStrong = cssVar('--accent-strong');
  const datasets = [
    {
      label: 'AC teljesítmény (kW)',
      data: hs.map((h) => +h.ac.toFixed(3)),
      borderColor: accentStrong,
      backgroundColor: withAlpha(cssVar('--accent'), 0.3),
      fill: true,
      tension: 0.35,
      pointRadius: 2,
      yAxisID: 'y',
    },
  ];
  if (hasClip) {
    datasets.push({
      label: 'Levágás nélkül (kW)',
      data: hs.map((h) => +h.acUnclipped.toFixed(3)),
      borderColor: cssVar('--danger'),
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
      tension: 0.35,
      yAxisID: 'y',
    });
  }
  if (hasClip) {
    datasets.push({
      label: 'Inverter limit',
      data: hs.map(() => cfg.invKw),
      borderColor: cssVar('--muted'),
      borderWidth: 1,
      borderDash: [2, 3],
      pointRadius: 0,
      fill: false,
      yAxisID: 'y',
    });
  }
  datasets.push(
    {
      label: 'Felhőzet (%)',
      data: hs.map((h) => h.cloud),
      borderColor: withAlpha(cssVar('--primary'), 0.6),
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      yAxisID: 'y2',
    },
  );

  const data = { labels: hs.map((h) => `${String(h.hour).padStart(2, '0')}:00`), datasets };
  const yMax = Math.max(cfg.invKw * (hasClip ? 1.15 : 0), ...hs.map((h) => h.acUnclipped)) * 1.1 || 1;

  if (hourlyChart) {
    hourlyChart.data = data;
    hourlyChart.options.scales.y.suggestedMax = yMax;
    hourlyChart.update();
    return;
  }
  hourlyChart = new Chart($('#hourlyChart'), {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const h = +items[0].label.slice(0, 2);
              return `${items[0].label}–${String((h + 1) % 24).padStart(2, '0')}:00`;
            },
            label: (item) => `${item.dataset.label}: ${fmt(item.parsed.y, item.dataset.yAxisID === 'y2' ? 0 : 2)}`,
          },
        },
      },
      scales: {
        y: { beginAtZero: true, suggestedMax: yMax, title: { display: true, text: 'kW' } },
        y2: { position: 'right', min: 0, max: 100, grid: { display: false }, title: { display: true, text: 'Felhőzet %' } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderTable() {
  const { days } = lastResult;
  const max = Math.max(...days.map((d) => d.energy), 0.001);
  $('#dayTable tbody').innerHTML = days.map((d) => {
    const rel = reliability(d.idx);
    const [icon, text] = WEATHER[d.code] || ['❔', 'Ismeretlen'];
    return `<tr data-date="${d.date}" class="${d.date === selectedDay ? 'selected' : ''}">
      <td>${d.idx === 0 ? '<b>Ma</b> · ' : d.idx === 1 ? '<b>Holnap</b> · ' : ''}${dayName(d.date, true)}</td>
      <td title="${esc(text)}">${icon} <span class="muted">${esc(text)}</span></td>
      <td class="num">${fmt(Math.round(d.tmin) + 0, 0)}…${fmt(Math.round(d.tmax) + 0, 0)} °C</td>
      <td class="num">${fmt(d.sunshine)} h</td>
      <td class="num energy"><span class="bar" style="width:${Math.round((d.energy / max) * 60)}px"></span>${d.missing ? '~' : ''}${fmt(d.energy)} kWh</td>
      <td class="num">${fmt(d.peak, 2)} kW</td>
      <td class="num">${d.clip > 0.05 ? fmt(d.clip) + ' kWh' : '–'}</td>
      <td><span class="badge ${rel.cls}">${rel.text}</span></td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#dayTable tbody tr').forEach((tr) => {
    tr.onclick = () => selectDay(tr.dataset.date);
  });
}

function downloadCsv() {
  if (!lastResult) return;
  const rows = [['idopont_kezdete', 'dc_kw', 'ac_kw', 'levagas_kw', 'felhozet_szazalek']];
  for (const d of lastResult.days) {
    for (const h of d.hours) {
      rows.push([h.start, h.dc.toFixed(3), h.ac.toFixed(3), h.clip.toFixed(3), h.cloud ?? '']);
    }
  }
  const blob = new Blob([rows.map((r) => r.join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `napelem-elorejelzes-${lastResult.days[0].date}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Indítás
// ---------------------------------------------------------------------------

function init() {
  bindSettings();
  renderArrays();
  initMap();
  setLocation(state.lat, state.lon, { pan: false });
  if (typeof Chart === 'undefined') {
    showMsg('A grafikon-könyvtár nem töltődött be (nincs internet?). A táblázat ettől még működik.', 'error');
  }
  calculate();

  // Témaváltáskor a grafikonok színeit újra kell számolni
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    dailyChart?.destroy(); hourlyChart?.destroy();
    dailyChart = hourlyChart = null;
    render();
  });
}

document.addEventListener('DOMContentLoaded', init);
