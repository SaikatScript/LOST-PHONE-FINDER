// Lost Phone Finder — web tracker
// Same Firebase project, same account, same Firestore docs as the app.
// Read-only: it never writes device or location data.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  query,
  orderBy,
  limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const L = window.L;
const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ONLINE_WINDOW_MS = 15 * 60 * 1000;

const state = {
  user: null,
  view: 'boot',
  devices: [],
  devicesLoaded: false,
  deviceId: null,
  device: null,
  locations: [],
  unsubDevices: null,
  unsubDevice: null,
  unsubLocations: null,
  map: null,
  layers: null,
  fitted: false,
};

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const ICONS = {
  shield: '<path d="M12 3 5 6v5.5c0 4.6 3 7.6 7 9.5 4-1.9 7-4.9 7-9.5V6l-7-3Z"/>',
  phone:
    '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  pin: '<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M21 10v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  signal: '<path d="M4 20V10M10 20V4M16 20v-7M22 20v-3"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V4a1 1 0 0 1 1-1h9"/>',
};

function icon(name, size = 18) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

function brandMark() {
  return h('span', { class: 'brand-mark' }, icon('shield', 21));
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  return null;
}

function timeAgo(date) {
  if (!date) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(date) {
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '—';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function sourceLabel(source) {
  if (source === 'mesh') return 'Mesh relay';
  if (source === 'network') return 'Network';
  if (source === 'gps') return 'GPS';
  return source ? String(source) : 'Unknown';
}

function batteryClass(level) {
  if (level == null) return '';
  if (level <= 15) return 'low';
  if (level <= 40) return 'warn';
  return '';
}

function batteryNode(level, withBar = true) {
  const value = typeof level === 'number' ? Math.round(level) : null;
  return h(
    'span',
    { class: 'battery' },
    withBar
      ? h(
          'span',
          { class: 'battery-track' },
          h('span', {
            class: `battery-fill ${batteryClass(value)}`,
            style: `width:${Math.max(3, Math.min(100, value ?? 0))}%`,
          })
        )
      : null,
    value == null ? '—' : `${value}%`
  );
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

function friendlyAuthError(error) {
  const code = error?.code || '';
  if (
    code.includes('invalid-credential') ||
    code.includes('wrong-password') ||
    code.includes('user-not-found')
  ) {
    return 'Wrong email or password. Use the same account as the app.';
  }
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute and try again.';
  if (code.includes('invalid-email')) return 'That email address is not valid.';
  if (code.includes('network')) return 'Network error — check your connection and try again.';
  return error?.message || 'Something went wrong.';
}

/* ------------------------------------------------------------------ */
/* Auth screen                                                         */
/* ------------------------------------------------------------------ */

function renderBoot() {
  state.view = 'boot';
  clear(appEl);
  appEl.append(
    h('div', { class: 'boot' }, h('div', { class: 'spinner' }), h('div', { text: 'Loading…' }))
  );
}

function renderAuth() {
  state.view = 'auth';
  document.title = 'Sign in — Lost Phone Finder';
  clear(appEl);

  const errorEl = h('div', { class: 'alert', role: 'alert' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
  const emailInput = h('input', {
    id: 'email',
    type: 'email',
    name: 'email',
    autocomplete: 'email',
    inputmode: 'email',
    placeholder: 'you@example.com',
    required: true,
  });
  const passInput = h('input', {
    id: 'password',
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    placeholder: 'Your password',
    required: true,
  });

  const lastEmail = window.localStorage.getItem('lpf.email');
  if (lastEmail) emailInput.value = lastEmail;

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add('is-visible');
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Signing in…' : 'Sign in';
  }

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        errorEl.classList.remove('is-visible');
        setBusy(true);
        try {
          await signInWithEmailAndPassword(auth, emailInput.value.trim(), passInput.value);
          window.localStorage.setItem('lpf.email', emailInput.value.trim());
        } catch (error) {
          showError(friendlyAuthError(error));
          setBusy(false);
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), emailInput),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), passInput),
    errorEl,
    submit
  );

  const forgot = h(
    'button',
    {
      type: 'button',
      class: 'btn btn--quiet',
      onclick: async () => {
        const email = emailInput.value.trim();
        if (!email) {
          showError('Enter your email address first, then tap “Forgot password”.');
          return;
        }
        try {
          await sendPasswordResetEmail(auth, email);
          toast('Password reset link sent — check your inbox and spam.');
        } catch (error) {
          showError(friendlyAuthError(error));
        }
      },
    },
    'Forgot password'
  );

  const hero = h(
    'section',
    { class: 'auth-hero' },
    h(
      'div',
      { class: 'brand' },
      brandMark(),
      h('div', {}, 'Lost Phone Finder', h('small', { text: 'WEB TRACKER' }))
    ),
    h('h1', {}, 'Find your phone.', h('br'), h('span', {}, 'Even without internet.')),
    h(
      'p',
      {},
      'Sign in with the same account you use in the app. Your devices, latest fix and location history appear here in real time.'
    ),
    h(
      'div',
      { class: 'hero-list' },
      h(
        'div',
        { class: 'hero-item' },
        h('span', { class: 'hero-icon' }, icon('pin', 16)),
        h('div', {}, h('strong', {}, 'Live location'), 'Satellite map with accuracy circle and fix age.')
      ),
      h(
        'div',
        { class: 'hero-item' },
        h('span', { class: 'hero-icon' }, icon('signal', 16)),
        h('div', {}, h('strong', {}, 'Offline mesh fixes'), 'Locations relayed by other phones show up here too.')
      ),
      h(
        'div',
        { class: 'hero-item' },
        h('span', { class: 'hero-icon' }, icon('shield', 16)),
        h('div', {}, h('strong', {}, 'Private by design'), 'Only your account can read your devices (Firebase rules).')
      )
    )
  );

  const formPanel = h(
    'section',
    { class: 'auth-form' },
    h(
      'div',
      { class: 'brand' },
      brandMark(),
      h('div', {}, 'Lost Phone Finder', h('small', { text: 'WEB TRACKER' }))
    ),
    h('h2', {}, 'Welcome back'),
    h('p', { class: 'sub' }, 'Use the same email and password as the mobile app.'),
    form,
    h('div', { class: 'auth-actions' }, forgot),
    h(
      'p',
      { class: 'auth-foot' },
      'Lost your phone and forgot the password? Use “Forgot password” — the reset link goes to your email.'
    )
  );

  appEl.append(h('div', { class: 'auth-wrap' }, h('div', { class: 'auth-shell' }, hero, formPanel)));
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function renderShell() {
  clear(appEl);
  const main = h('main', { id: 'main', class: 'page' });
  const topbar = h(
    'header',
    { class: 'topbar' },
    h(
      'a',
      { class: 'brand', href: '#/', style: 'color:inherit;text-decoration:none' },
      brandMark(),
      h('div', {}, 'Lost Phone Finder', h('small', { text: 'WEB TRACKER' }))
    ),
    h(
      'div',
      { class: 'topbar-right' },
      h('span', { class: 'chip chip--ok live-pill is-on' }, 'Live updates'),
      h('span', { class: 'topbar-user', text: state.user?.email || '' }),
      h(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          onclick: async () => {
            try {
              await signOut(auth);
            } catch (error) {
              toast(error.message);
            }
          },
        },
        'Sign out'
      )
    )
  );
  appEl.append(topbar, main);
  return main;
}

/* ------------------------------------------------------------------ */
/* Devices list                                                        */
/* ------------------------------------------------------------------ */

function cleanupDevice(removeMap = true) {
  state.unsubDevice?.();
  state.unsubDevice = null;
  state.unsubLocations?.();
  state.unsubLocations = null;
  if (removeMap && state.map) {
    state.map._lpfObserver?.disconnect();
    state.map.remove();
    state.map = null;
    state.layers = null;
  }
  state.device = null;
  state.locations = [];
  state.fitted = false;
}

function deviceChips(device) {
  const chips = [];
  if (device.isLost) chips.push({ label: 'LOST', tone: 'bad' });
  if (device.simSwapped) chips.push({ label: 'SIM swapped', tone: 'bad' });
  const seen = toDate(device.lastUpdate);
  if (seen && Date.now() - seen.getTime() < ONLINE_WINDOW_MS) {
    chips.push({ label: 'Live', tone: 'ok' });
  } else {
    chips.push({ label: 'Offline', tone: 'plain' });
  }
  if (device.lastLocationSource === 'mesh') chips.push({ label: 'Mesh fix', tone: 'info' });
  return chips;
}

function chipNode(chip) {
  return h('span', { class: `chip chip--${chip.tone}` }, chip.label);
}

function renderDevices() {
  state.view = 'devices';
  cleanupDevice();
  document.title = 'My devices — Lost Phone Finder';
  const main = document.getElementById('main');
  if (!main) return;
  clear(main);

  const devices = state.devices;
  const lost = devices.filter((d) => d.isLost).length;

  main.append(
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('h1', {}, 'My devices'),
        h(
          'p',
          {},
          devices.length === 0
            ? 'Devices you add in the app appear here automatically.'
            : `${devices.length} device${devices.length === 1 ? '' : 's'}${lost ? ` · ${lost} marked LOST` : ''}`
        )
      ),
      h('span', { class: 'chip chip--ok' }, 'Live')
    )
  );

  if (!state.devicesLoaded) {
    main.append(
      h(
        'div',
        { class: 'card empty' },
        h('div', { class: 'spinner' }),
        h('p', { class: 'muted' }, 'Loading your devices…')
      )
    );
    return;
  }

  if (devices.length === 0) {
    main.append(
      h(
        'div',
        { class: 'card empty' },
        h('div', { class: 'big' }, '📱'),
        h('h2', {}, 'No devices yet'),
        h(
          'p',
          {},
          'Open the Lost Phone Finder app on the phone you want to protect, add it to this account, and it will show up here within seconds.'
        )
      )
    );
    return;
  }

  const grid = h('div', { class: 'device-grid' });
  for (const device of devices) {
    const seen = toDate(device.lastUpdate);
    const battery = device.lastBattery;
    grid.append(
      h(
        'button',
        {
          class: 'device-card',
          type: 'button',
          onclick: () => {
            window.location.hash = `#/device/${encodeURIComponent(device.id)}`;
          },
        },
        h(
          'div',
          { class: 'device-top' },
          h(
            'div',
            { style: 'min-width:0' },
            h('div', { class: 'device-name', text: device.deviceName || 'My Android' }),
            h('div', { class: 'device-model', text: device.deviceModel || 'Unknown model' })
          ),
          h('span', { class: 'device-icon' }, icon('phone', 19))
        ),
        h('div', { class: 'chip-row' }, deviceChips(device).map(chipNode)),
        h(
          'div',
          { class: 'device-meta' },
          batteryNode(battery),
          h('span', { text: seen ? `Seen ${timeAgo(seen)}` : 'Never seen' })
        )
      )
    );
  }
  main.append(grid);
  main.append(
    h(
      'p',
      { class: 'faint', style: 'font-size:12.5px;text-align:center;margin-top:6px' },
      'Read-only web view · data stays in your own Firebase project'
    )
  );
}

/* ------------------------------------------------------------------ */
/* Device detail                                                       */
/* ------------------------------------------------------------------ */

function latestFix(device, locations) {
  if (!device) return null;
  const location = device.lastLocation;
  if (location && typeof location.latitude === 'number' && typeof location.longitude === 'number') {
    return {
      lat: location.latitude,
      lng: location.longitude,
      accuracy: typeof device.lastAccuracy === 'number' ? device.lastAccuracy : null,
      at: device.lastLocationAt ? new Date(device.lastLocationAt) : toDate(device.lastUpdate),
      source: device.lastLocationSource || 'gps',
      battery: device.lastBattery,
    };
  }
  const first = locations[0];
  if (first && typeof first.lat === 'number') {
    return {
      lat: first.lat,
      lng: first.lng,
      accuracy: typeof first.accuracy === 'number' ? first.accuracy : null,
      at: toDate(first.timestamp),
      source: first.source || 'gps',
      battery: first.battery,
    };
  }
  return null;
}

function renderDevice(deviceId) {
  if (state.view === 'device' && state.deviceId === deviceId && state.map) return;

  state.view = 'device';
  state.deviceId = deviceId;
  cleanupDevice();
  const main = document.getElementById('main');
  if (!main) return;
  clear(main);
  document.title = 'Device — Lost Phone Finder';

  const nameEl = h('h1', { text: 'Loading…' });
  const modelEl = h('p', { class: 'sub', text: '' });
  const chipsEl = h('div', { class: 'chip-row' });
  const stats = {};

  function stat(key, label) {
    const value = h('div', { class: 'v', text: '—' });
    const sub = h('div', { class: 's', text: '' });
    stats[key] = { value, sub };
    return h('div', { class: 'card stat' }, h('div', { class: 'k', text: label }), value, sub);
  }

  const mapEl = h('div', { id: 'map' });
  const mapBadge = h('div', { class: 'map-badge', text: 'Satellite · Esri World Imagery' });
  const recenter = h(
    'button',
    {
      class: 'btn btn--sm btn--ghost',
      type: 'button',
      onclick: () => {
        const fix = latestFix(state.device, state.locations);
        if (fix && state.map) {
          state.map.flyTo([fix.lat, fix.lng], 17, { duration: 0.8 });
        } else {
          toast('No location yet.');
        }
      },
    },
    '◎ Recenter'
  );

  const mapCard = h(
    'section',
    { class: 'card map-card' },
    h(
      'div',
      { class: 'map-shell' },
      mapEl,
      h('div', { class: 'map-overlay' }, recenter),
      mapBadge
    )
  );

  const historyList = h('div', { class: 'history-list' });
  const historyCount = h('span', { class: 'chip chip--plain', text: '0 fixes' });
  const historyCard = h(
    'section',
    { class: 'card history-card' },
    h('div', { class: 'history-head' }, h('h2', {}, 'Location history'), historyCount),
    historyList
  );

  const openMaps = h(
    'a',
    { class: 'btn btn--sm btn--ghost', target: '_blank', rel: 'noopener noreferrer', href: '#' },
    icon('external', 16),
    'Open in Google Maps'
  );

  const copyButton = h(
    'button',
    {
      class: 'btn btn--sm btn--ghost',
      type: 'button',
      onclick: async () => {
        const fix = latestFix(state.device, state.locations);
        if (!fix) return toast('No location yet.');
        const text = `${fix.lat}, ${fix.lng}`;
        try {
          await navigator.clipboard.writeText(text);
          toast('Coordinates copied.');
        } catch {
          toast(text);
        }
      },
    },
    icon('copy', 16),
    'Copy coordinates'
  );

  main.append(
    h(
      'div',
      {},
      h('a', { class: 'back', href: '#/' }, '← All devices'),
      h(
        'div',
        { class: 'device-head', style: 'margin-top:10px' },
        h('div', {}, h('div', {}, nameEl), modelEl),
        h('div', { class: 'chip-row' }, chipsEl)
      )
    ),
    h(
      'div',
      { class: 'stat-grid' },
      stat('battery', 'Battery'),
      stat('accuracy', 'Accuracy'),
      stat('seen', 'Last seen'),
      stat('source', 'Source')
    ),
    mapCard,
    h('div', { class: 'actions-row' }, openMaps, copyButton),
    historyCard
  );

  initMap();

  state.unsubDevice = onSnapshot(
    doc(db, 'users', state.user.uid, 'devices', deviceId),
    (snapshot) => {
      if (!snapshot.exists()) {
        toast('This device no longer exists.');
        cleanupDevice();
        window.location.hash = '#/';
        return;
      }
      state.device = { id: snapshot.id, ...snapshot.data() };
      updateDeviceUI();
    },
    (error) => {
      toast(`Could not load this device: ${error.message}`);
    }
  );

  state.unsubLocations = onSnapshot(
    query(
      collection(db, 'users', state.user.uid, 'devices', deviceId, 'locations'),
      orderBy('timestamp', 'desc'),
      limit(50)
    ),
    (snapshot) => {
      state.locations = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      updateDeviceUI();
    },
    (error) => {
      toast(`Could not load history: ${error.message}`);
    }
  );

  function updateDeviceUI() {
    const device = state.device;
    if (!device) return;
    const fix = latestFix(device, state.locations);
    const seen = toDate(device.lastUpdate) || fix?.at || null;

    document.title = `${device.deviceName || 'Device'} — Lost Phone Finder`;
    nameEl.textContent = device.deviceName || 'My Android';
    modelEl.textContent = device.deviceModel || 'Unknown model';

    clear(chipsEl);
    for (const chip of deviceChips(device)) chipsEl.append(chipNode(chip));

    stats.battery.value.textContent =
      typeof device.lastBattery === 'number' ? `${Math.round(device.lastBattery)}%` : '—';
    stats.battery.sub.textContent = 'last reading on the phone';

    stats.accuracy.value.textContent = fix?.accuracy != null ? `±${Math.round(fix.accuracy)} m` : '—';
    stats.accuracy.sub.textContent = fix?.accuracy != null ? 'GPS confidence' : 'no fix yet';

    stats.seen.value.textContent = seen ? timeAgo(seen) : 'never';
    stats.seen.sub.textContent = seen ? fmtDateTime(seen) : 'waiting for a check-in';

    stats.source.value.textContent = fix ? sourceLabel(fix.source) : '—';
    stats.source.sub.textContent = fix?.at ? fmtDateTime(fix.at) : 'no location data';

    if (fix) {
      openMaps.href = `https://www.google.com/maps/search/?api=1&query=${fix.lat},${fix.lng}`;
      openMaps.hidden = false;
    } else {
      openMaps.hidden = true;
    }

    renderHistory(device, fix);
    updateMap(fix);
  }

  function renderHistory(device, fix) {
    clear(historyList);
    historyCount.textContent = `${state.locations.length} fix${
      state.locations.length === 1 ? '' : 'es'
    }`;
    if (state.locations.length === 0) {
      historyList.append(
        h(
          'div',
          { class: 'history-empty' },
          'No location history yet. Open the app on your phone and tap “Send location now”.'
        )
      );
      return;
    }
    for (const entry of state.locations) {
      const at = toDate(entry.timestamp);
      const source = entry.source || 'gps';
      const isLatest = fix && Math.abs(entry.lat - fix.lat) < 1e-9 && Math.abs(entry.lng - fix.lng) < 1e-9;
      historyList.append(
        h(
          'button',
          {
            class: 'history-row',
            type: 'button',
            onclick: () => {
              if (!state.map) return;
              state.map.flyTo([entry.lat, entry.lng], 17, { duration: 0.7 });
            },
          },
          h('span', { class: 'history-time', text: at ? timeAgo(at) : 'unknown time' }),
          h(
            'span',
            {},
            h('span', { class: 'history-coords', text: fmtCoords(entry.lat, entry.lng) }),
            h(
              'span',
              { class: 'faint', style: 'margin-left:8px;font-size:12px' },
              entry.accuracy != null ? `±${Math.round(entry.accuracy)} m` : ''
            )
          ),
          h(
            'span',
            { class: 'history-tags' },
            isLatest ? h('span', { class: 'chip chip--ok chip--plain' }, 'Latest') : null,
            h('span', { class: 'chip chip--plain' }, sourceLabel(source)),
            typeof entry.battery === 'number'
              ? h('span', { class: 'chip chip--plain' }, `${Math.round(entry.battery)}%`)
              : null
          )
        )
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Map                                                                 */
/* ------------------------------------------------------------------ */

function initMap() {
  if (!L) {
    toast('Map library failed to load — check your internet connection.');
    return;
  }
  const container = document.getElementById('map');
  if (!container || state.map) return;

  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
  }).setView([21.0, 78.0], 5);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const satellite = L.tileLayer(ESRI_IMAGERY, {
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  }).addTo(map);

  const streets = L.tileLayer(OSM_TILES, {
    maxZoom: 19,
    maxNativeZoom: 16,
    attribution: '© OpenStreetMap contributors',
  });

  L.control
    .layers({ Satellite: satellite, Streets: streets }, null, { position: 'topright', collapsed: true })
    .addTo(map);

  state.map = map;
  state.layers = L.layerGroup().addTo(map);

  requestAnimationFrame(() => map.invalidateSize());

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    map._lpfObserver = observer;
  }
}

function updateMap(fix) {
  const map = state.map;
  const layers = state.layers;
  if (!map || !layers) return;
  layers.clearLayers();

  const points = [];

  for (const entry of [...state.locations].reverse()) {
    if (typeof entry.lat !== 'number' || typeof entry.lng !== 'number') continue;
    points.push([entry.lat, entry.lng]);
    L.marker([entry.lat, entry.lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="pin pin--old"></div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
      keyboard: false,
    })
      .addTo(layers)
      .bindPopup(popupFor(entry, false));
  }

  if (fix) {
    L.circle([fix.lat, fix.lng], {
      radius: fix.accuracy && fix.accuracy > 0 ? fix.accuracy : 40,
      color: '#3D8BFF',
      weight: 1,
      fillColor: '#3D8BFF',
      fillOpacity: 0.08,
      opacity: 0.45,
    }).addTo(layers);

    const latestMarker = L.marker([fix.lat, fix.lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="pin"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      zIndexOffset: 1000,
    })
      .addTo(layers)
      .bindPopup(popupFor(fix, true), { autoClose: false });

    if (window.innerWidth >= 700) latestMarker.openPopup();

    points.push([fix.lat, fix.lng]);
  }

  if (points.length > 1) {
    L.polyline(points, {
      color: '#3D8BFF',
      weight: 2,
      opacity: 0.45,
      dashArray: '5 7',
    }).addTo(layers);
  }

  if (points.length && !state.fitted) {
    state.fitted = true;
    map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 17 });
  }
}

function popupFor(fix, isLatest) {
  const accuracy =
    fix.accuracy != null ? `±${Math.round(fix.accuracy)} m accuracy` : 'accuracy unknown';
  return h(
    'div',
    {},
    h('b', { text: isLatest ? 'Latest location' : 'Earlier fix' }),
    h('div', { class: 'muted', text: fmtDateTime(fix.at) }),
    h('div', { class: 'mono', text: fmtCoords(fix.lat, fix.lng) }),
    h('div', { class: 'muted', text: `${accuracy} · ${sourceLabel(fix.source)}` })
  );
}

/* ------------------------------------------------------------------ */
/* Data + routing                                                      */
/* ------------------------------------------------------------------ */

function subscribeDevices() {
  state.unsubDevices?.();
  state.devicesLoaded = false;
  state.unsubDevices = onSnapshot(
    collection(db, 'users', state.user.uid, 'devices'),
    (snapshot) => {
      state.devicesLoaded = true;
      state.devices = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ta = toDate(a.lastUpdate)?.getTime() || 0;
          const tb = toDate(b.lastUpdate)?.getTime() || 0;
          return tb - ta;
        });
      if (state.view === 'devices') renderDevices();
    },
    (error) => {
      state.devicesLoaded = true;
      toast(`Could not load devices: ${error.message}`);
      if (state.view === 'devices') renderDevices();
    }
  );
}

function route() {
  if (!state.user) return;
  const match = window.location.hash.match(/^#\/device\/([^/?#]+)/);
  if (match) renderDevice(decodeURIComponent(match[1]));
  else renderDevices();
}

function teardown() {
  state.unsubDevices?.();
  state.unsubDevices = null;
  cleanupDevice();
  state.devices = [];
  state.devicesLoaded = false;
  state.user = null;
  state.view = 'boot';
}

window.addEventListener('hashchange', route);

onAuthStateChanged(auth, (user) => {
  if (user) {
    state.user = user;
    renderShell();
    subscribeDevices();
    route();
  } else {
    teardown();
    renderAuth();
  }
});

renderBoot();
