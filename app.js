/*
 * app.js — UI for the NPK soil probe readout.
 *
 * All protocol knowledge lives in npk-ble.js. This file only turns events into
 * pixels, and turns the handful of failures that are actually normal into
 * sentences a technician can act on.
 */

import {
  CHANNELS, NpkDevice, DemoDevice,
  checkSupport, Support, SUPPORT_MESSAGE, bluefyUrl,
} from './npk-ble.js';

const BLUEFY_APP_STORE = 'https://apps.apple.com/app/id1492822055';

const $ = id => document.getElementById(id);

const els = {
  status:     $('status'),
  statusText: $('statusText'),
  device:     $('device'),
  connect:    $('connect'),
  reconnect:  $('reconnect'),
  disconnect: $('disconnect'),
  banners:    $('banners'),
  readings:   $('readings'),
  freshness:  $('freshness'),
  demo:       $('demo'),
  build:      $('build'),
};

let probe = new NpkDevice();
let demoMode = false;
let lastChangeAt = null;

/* ---------- cards ---------- */

const cards = new Map();

function buildCards() {
  const tpl = $('cardTemplate');
  for (const ch of CHANNELS) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.card-label').textContent = ch.label;
    node.querySelector('.u').textContent = ch.unit;
    els.readings.append(node);
    cards.set(ch.key, {
      root:  node,
      value: node.querySelector('.v'),
      note:  node.querySelector('.card-note'),
      channel: ch,
    });
  }
}

function renderReading(key, value) {
  const card = cards.get(key);
  if (!card) return;
  const { channel } = card;

  if (value === null) {
    // The probe is telling us it has nothing. Ten seconds without an answer
    // from the RS485 bus and every characteristic reports its not-known code.
    card.root.dataset.state = 'unknown';
    card.value.textContent = 'No reading';
    card.note.textContent = 'Probe not answering';
    return;
  }

  const outOfRange = value < channel.min || value > channel.max;
  card.root.dataset.state = outOfRange ? 'out-of-range' : 'ok';
  card.value.textContent = value.toFixed(channel.decimals);
  card.note.textContent = outOfRange
    ? `Outside the specified ${channel.min}–${channel.max} ${channel.unit}`
    : '';
}

function resetCards() {
  for (const card of cards.values()) {
    card.root.dataset.state = 'idle';
    card.value.textContent = '—';
    card.note.textContent = '';
  }
  lastChangeAt = null;
  els.freshness.hidden = true;
}

/* ---------- status and buttons ---------- */

const STATUS_TEXT = {
  disconnected: 'Not connected',
  connecting:   'Connecting…',
  connected:    'Live',
};

function renderState() {
  const state = probe.state;
  els.status.dataset.state = state;
  els.statusText.textContent = STATUS_TEXT[state];

  const busy = state === 'connecting';
  const live = state === 'connected';
  const known = probe.canReconnect;

  // Once a probe has been chosen, Reconnect is the primary action — it needs no
  // fresh trip through the browser chooser. Connect stays available for the
  // second unit on the bench.
  els.connect.hidden     = live;
  els.connect.disabled   = busy || supportBlocked;
  els.connect.textContent = known ? 'Choose another probe' : 'Connect to a probe';
  els.connect.classList.toggle('primary', !known);

  els.reconnect.hidden   = live || !known;
  els.reconnect.disabled = busy;
  els.reconnect.classList.toggle('primary', known);

  els.disconnect.hidden = !live;

  els.device.hidden = !probe.name;
  if (probe.name) els.device.textContent = probe.name;
}

/* ---------- banners ---------- */

function banner(kind, title, ...paragraphs) {
  const el = document.createElement('div');
  el.className = 'banner ' + kind;
  const h = document.createElement('h3');
  h.textContent = title;
  el.append(h);
  for (const text of paragraphs) {
    const p = document.createElement('p');
    p.textContent = text;
    el.append(p);
  }
  return el;
}

/* The demo notice outlives everything else on screen: it has to stay visible
 * while demo readings are arriving, and connecting clears the banner area. */
function demoBanner() {
  return banner('info', 'Demo mode',
    'Simulated readings, no hardware. It walks plausible values on the firmware’s own two-second period and drops into the not-known state every so often, so the “probe not answering” display can be checked without unplugging anything.');
}

function showBanner(kind, title, ...paragraphs) {
  const nodes = [banner(kind, title, ...paragraphs)];
  if (demoMode) nodes.unshift(demoBanner());
  els.banners.replaceChildren(...nodes);
}

function showBannerNode(el) {
  els.banners.replaceChildren(...(demoMode ? [demoBanner(), el] : [el]));
}

/*
 * The iOS bridge. One tap hands this page to Bluefy through its custom scheme;
 * the copy button is the fallback for when the handoff is refused, which it can
 * be if Bluefy is not installed and iOS has nothing to open the scheme with.
 */
function bluefyBanner() {
  const el = banner('caution', 'Open this page in Bluefy',
    SUPPORT_MESSAGE[Support.NEEDS_WEBBLE],
    'Demo mode below still works here, so the display can be checked without leaving Safari.');

  const row = document.createElement('div');
  row.className = 'acts';

  const open = document.createElement('a');
  open.className = 'act primary';
  open.href = bluefyUrl();
  open.textContent = 'Open in Bluefy';
  row.append(open);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'act';
  copy.textContent = 'Copy the address instead';
  copy.addEventListener('click', () => copyPageLink(copy));
  row.append(copy);

  el.append(row);

  const fine = document.createElement('p');
  fine.className = 'fine';
  fine.append(document.createTextNode('Nothing happened? Bluefy is probably not installed — '));
  const store = document.createElement('a');
  store.href = BLUEFY_APP_STORE;
  store.textContent = 'get it from the App Store';
  fine.append(store, document.createTextNode(', then tap again.'));
  el.append(fine);

  return el;
}

/* Fallback for when the scheme handoff does nothing: put the address on the
 * clipboard, ready to paste into Bluefy's own address bar. */
function copyPageLink(btn) {
  const url = location.href;
  const done = () => {
    btn.textContent = 'Copied — paste it into Bluefy';
    btn.disabled = true;
  };
  try {
    navigator.clipboard.writeText(url).then(done, () => prompt('Copy this address:', url));
  } catch {
    prompt('Copy this address:', url);
  }
}

function clearBanners() {
  els.banners.replaceChildren(...(demoMode ? [demoBanner()] : []));
}

/* ---------- freshness ---------- */
/*
 * The firmware notifies only when a value changes, so silence is the normal
 * state of a stable probe in stable soil. Say that plainly — otherwise a quiet
 * reading looks like a dropped connection and gets reported as a fault.
 */
function renderFreshness() {
  if (probe.state !== 'connected' || lastChangeAt === null) {
    els.freshness.hidden = true;
    return;
  }
  const seconds = Math.round((Date.now() - lastChangeAt) / 1000);
  els.freshness.hidden = false;
  els.freshness.textContent = seconds < 5
    ? 'Updated just now.'
    : `Unchanged for ${seconds} s — the probe reports only when a value moves, so this is normal.`;
}

setInterval(renderFreshness, 1000);

/* ---------- wiring a device ---------- */

function attach(device) {
  probe = device;
  let previous = device.state;

  probe.addEventListener('state', () => {
    renderState();
    if (probe.state === 'connecting') {
      // The disconnect we were expecting has been and gone.
      deliberate = false;
    } else if (probe.state === 'connected') {
      clearBanners();
    } else if (probe.state === 'disconnected') {
      renderFreshness();
      // Only a link that went away on its own gets the stale-values warning;
      // a deliberate Disconnect clears the screen instead.
      if (previous === 'connected' && !deliberate) onLinkLost();
    }
    previous = probe.state;
  });

  probe.addEventListener('reading', ev => {
    const { key, value, at } = ev.detail;
    renderReading(key, value);
    lastChangeAt = at;
    renderFreshness();
  });

  probe.addEventListener('error', ev => {
    const { kind, message } = ev.detail;
    if (kind === 'not-found') {
      showBanner('info', 'No probe selected',
        message,
        'If the probe was not in the list at all, open “The probe isn’t in the list” below — there are three ordinary reasons for that.');
    } else {
      showBanner('bad', 'Could not connect', message);
    }
    renderState();
  });

  probe.addEventListener('log', ev => console.warn('[npk]', ev.detail.message));

  renderState();
}

/* ---------- disconnect handling ---------- */
/*
 * A dropped link is a different failure from a dead probe, and needs saying
 * differently: the readings on screen are now stale rather than absent.
 */
let deliberate = false;

function onLinkLost() {
  for (const card of cards.values()) {
    if (card.root.dataset.state !== 'idle') card.root.style.opacity = '.5';
  }
  showBanner('caution', 'Disconnected',
    'The link to the probe has gone. The values above are the last ones received, not current.',
    'Out of range, the probe rebooting, or Bluetooth switched off at either end will all do this. Press Reconnect to try again.');
}

/* ---------- actions ---------- */

els.connect.addEventListener('click', async () => {
  // Choosing a probe replaces whatever we had, so drop the old one first.
  deliberate = true;   // cleared again when the next connection starts
  probe.forget();
  freshStart();
  await probe.requestAndConnect();
});

els.reconnect.addEventListener('click', async () => {
  freshStart();
  await probe.connect();
});

els.disconnect.addEventListener('click', () => {
  deliberate = true;
  probe.disconnect();          // keeps the chosen device, so Reconnect stays cheap
  freshStart();
  renderState();
});

function freshStart() {
  clearBanners();
  resetCards();
  clearStale();
}

function clearStale() {
  for (const card of cards.values()) card.root.style.opacity = '';
}

els.demo.addEventListener('click', () => {
  deliberate = true;
  probe.forget();
  demoMode = !demoMode;
  resetCards();
  clearStale();
  attach(demoMode ? new DemoDevice() : new NpkDevice());
  els.demo.textContent = demoMode ? 'Leave demo mode' : 'Demo mode';
  clearBanners();
  if (demoMode) {
    probe.connect();
  } else {
    describeSupport();
  }
});

/* ---------- startup ---------- */

let supportBlocked = false;

function describeSupport() {
  const support = checkSupport();
  supportBlocked = support === Support.INSECURE
    || support === Support.UNSUPPORTED
    || support === Support.NEEDS_WEBBLE;
  if (support === Support.OK) return;

  if (support === Support.NEEDS_WEBBLE) {
    showBannerNode(bluefyBanner());
  } else if (supportBlocked) {
    showBanner('bad',
      support === Support.INSECURE ? 'Not served over HTTPS' : 'No Web Bluetooth in this browser',
      SUPPORT_MESSAGE[support],
      'Demo mode below still works, so the display can be reviewed here.');
  } else {
    showBanner('caution', 'Running inside a frame', SUPPORT_MESSAGE[support]);
  }
}

buildCards();
resetCards();
describeSupport();
attach(probe);

els.build.textContent = 'GATT rev 1 · read-only';

if ('serviceWorker' in navigator) {
  // Offline is the normal case: a technician in a paddy field may have no data
  // connection, and the page must already be installed by the time they get there.
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('[npk] service worker registration failed:', err.message);
    });
  });
}
