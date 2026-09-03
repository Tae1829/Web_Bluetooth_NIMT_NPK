/*
 * npk-ble.js — protocol layer for the NPK soil probe.
 *
 * Canonical source for everything in this file is the firmware:
 *   components/ble_reporter/ble_reporter.c
 *   components/ble_reporter/include/ble_reporter.h
 * Where this disagrees with the firmware, the firmware is right.
 *
 * No DOM in here. The UI layer subscribes to events.
 */

/* ---------- identifiers ---------- */

/* SIG-assigned identifiers are written out in full 128-bit form rather than as
 * 16-bit shorthand. Chrome resolves either, but third-party Web Bluetooth
 * implementations — Bluefy on iOS, which is how iPhones reach this at all — are
 * not all as forgiving, and the long form costs nothing. */
export const ESS_SERVICE    = '0000181a-0000-1000-8000-00805f9b34fb';   // 0x181A
export const VENDOR_SERVICE = '4e540001-0e77-63a1-8d47-2b5f4e9a0c21';

const TEMPERATURE  = '00002a6e-0000-1000-8000-00805f9b34fb';   // 0x2A6E
const MOISTURE     = '00002a6f-0000-1000-8000-00805f9b34fb';   // 0x2A6F — the SIG calls
                                                               // this Humidity; the
                                                               // product says Moisture
const NITROGEN     = '4e540002-0e77-63a1-8d47-2b5f4e9a0c21';
const PHOSPHORUS   = '4e540003-0e77-63a1-8d47-2b5f4e9a0c21';
const POTASSIUM    = '4e540004-0e77-63a1-8d47-2b5f4e9a0c21';
const CONDUCTIVITY = '4e540005-0e77-63a1-8d47-2b5f4e9a0c21';

/* The not-known codes. Neither can collide with a real reading: 0xFFFF is 65535,
 * far above the 20000 ceiling, and 0x8000 as a signed temperature is -327.68 C. */
const TEMPERATURE_UNKNOWN = -32768;   // 0x8000
const UNKNOWN             = 0xffff;

/* Ranges are for sanity-checking only. A value outside them is still shown, but
 * flagged — it means the probe or the firmware is misbehaving, and hiding it
 * would just make that harder to find. */
export const CHANNELS = [
  { key: 'temperature',  label: 'Temperature',  unit: '°C',    service: 'ess',    uuid: TEMPERATURE,  decimals: 1, min: -40, max: 80 },
  { key: 'moisture',     label: 'Moisture',     unit: '%',          service: 'ess',    uuid: MOISTURE,     decimals: 1, min: 0,   max: 100 },
  { key: 'nitrogen',     label: 'Nitrogen',     unit: 'mg/kg',      service: 'vendor', uuid: NITROGEN,     decimals: 0, min: 0,   max: 2999 },
  { key: 'phosphorus',   label: 'Phosphorus',   unit: 'mg/kg',      service: 'vendor', uuid: PHOSPHORUS,   decimals: 0, min: 0,   max: 2999 },
  { key: 'potassium',    label: 'Potassium',    unit: 'mg/kg',      service: 'vendor', uuid: POTASSIUM,    decimals: 0, min: 0,   max: 2999 },
  { key: 'conductivity', label: 'Conductivity', unit: 'µS/cm', service: 'vendor', uuid: CONDUCTIVITY, decimals: 0, min: 0,   max: 20000 },
];

/* ---------- decoding ---------- */
/* Every value is two bytes little-endian. null means the device is telling us it
 * has no reading — the probe has been silent for ten seconds. That is a state to
 * display, not an error to swallow. */

const DECODERS = {
  temperature:  dv => { const v = dv.getInt16(0, true);  return v === TEMPERATURE_UNKNOWN ? null : v / 100; },
  moisture:     dv => { const v = dv.getUint16(0, true); return v === UNKNOWN ? null : v / 100; },
  nitrogen:     dv => { const v = dv.getUint16(0, true); return v === UNKNOWN ? null : v; },
  phosphorus:   dv => { const v = dv.getUint16(0, true); return v === UNKNOWN ? null : v; },
  potassium:    dv => { const v = dv.getUint16(0, true); return v === UNKNOWN ? null : v; },
  conductivity: dv => { const v = dv.getUint16(0, true); return v === UNKNOWN ? null : v; },
};

export function decode(key, dataView) {
  if (dataView.byteLength < 2) {
    throw new Error(key + ': expected 2 bytes, got ' + dataView.byteLength);
  }
  return DECODERS[key](dataView);
}

/* ---------- capability check ---------- */

export const Support = {
  UNSUPPORTED:  'unsupported',    // no Web Bluetooth in this engine, and no way round it
  NEEDS_WEBBLE: 'needs-webble',   // iOS: stock browsers lack it, Bluefy has it
  INSECURE:     'insecure',       // http: — including the probe's web app at 192.168.4.1
  FRAMED:       'framed',         // present, but this frame may not have been granted it
  OK:           'ok',
};

/* iPadOS 13 and later report themselves as Macintosh, so the user agent alone
 * is not enough — a Mac with a touch screen is the thing that does not exist. */
export function isIOS() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/* Bluefy puts its name in the user agent, which is how we avoid offering to
 * send someone to Bluefy when they are already in it. */
export function isBluefy() {
  return /Bluefy/i.test(navigator.userAgent || '');
}

/*
 * Bluefy's custom scheme takes the whole https URL after it, scheme and all:
 *   bluefy://https://example.org/npk/
 * Anything else — a bare host, a path — does not open.
 */
export function bluefyUrl(href = location.href) {
  return 'bluefy://' + href;
}

export function checkSupport() {
  // Order matters: an insecure context hides navigator.bluetooth entirely, so
  // test the context first or every http: page looks like a browser without it.
  if (!window.isSecureContext) return Support.INSECURE;
  // On iOS this is not a dead end. Safari and Chrome there both use WebKit and
  // neither exposes Web Bluetooth, but Bluefy does, and the same URL works in
  // it unchanged — so send the user there rather than telling them no.
  // Already in Bluefy and still no API? Then sending them to Bluefy is a loop,
  // so fall through to the plain unsupported message.
  if (!navigator.bluetooth) {
    return isIOS() && !isBluefy() ? Support.NEEDS_WEBBLE : Support.UNSUPPORTED;
  }
  // A cross-origin frame without allow="bluetooth" exposes the object but
  // rejects requestDevice(). We warn, but still let the user try.
  if (window.self !== window.top) return Support.FRAMED;
  return Support.OK;
}

/* Adapter powered on? Resolves true when unknowable, so we never block on it. */
export async function adapterAvailable() {
  try {
    if (!navigator.bluetooth || !navigator.bluetooth.getAvailability) return true;
    return await navigator.bluetooth.getAvailability();
  } catch {
    return true;
  }
}

export const SUPPORT_MESSAGE = {
  [Support.UNSUPPORTED]:
    'This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows, macOS or Linux — or, on an iPhone or iPad, Bluefy.',
  [Support.NEEDS_WEBBLE]:
    'Safari has no Web Bluetooth, and Chrome and Edge on iOS are Safari underneath, so none of them can reach the probe. Bluefy is a browser that adds Web Bluetooth on iOS. Tap Open in Bluefy and iOS will hand this page straight to it — same address, same app, nothing else changes.',
  [Support.INSECURE]:
    'Web Bluetooth needs HTTPS. This page is served over plain HTTP, so the API is not exposed at all. A page served by the probe itself at 192.168.4.1 can never use Web Bluetooth — host this app elsewhere, over HTTPS.',
  [Support.FRAMED]:
    'This page is running inside a frame, which may not have been granted Bluetooth permission. If connecting fails, open it in its own tab.',
};

/* ---------- the device ---------- */

/*
 * Events:
 *   'state'    { state }               connecting | connected | disconnected
 *   'reading'  { key, value, at }      value === null means not-known
 *   'error'    { kind, message, cause }
 *   'log'      { message }
 */
export class NpkDevice extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.state = 'disconnected';
    this.characteristics = new Map();
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  get name() { return this.device ? this.device.name : null; }
  get canReconnect() { return this.device !== null; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', { state });
  }

  /* Must be called from a user gesture. */
  async requestAndConnect() {
    const support = checkSupport();
    if (support !== Support.OK && support !== Support.FRAMED) {
      this._fail(support, SUPPORT_MESSAGE[support]);
      return false;
    }
    if (!(await adapterAvailable())) {
      this._fail('adapter', 'No Bluetooth adapter available, or Bluetooth is switched off on this computer or phone.');
      return false;
    }

    let device;
    try {
      // Filter on the ESS UUID rather than the name prefix: more robust, and the
      // user still picks their unit by name in the browser chooser.
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [ESS_SERVICE] }],
        optionalServices: [VENDOR_SERVICE],   // without this the nutrients are unreachable
      });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotFoundError') {
        // Covers both "user pressed Cancel" and "nothing was advertising".
        this._fail('not-found', 'No probe was selected.', err);
      } else if (name === 'SecurityError' || name === 'NotAllowedError') {
        this._fail('framed', SUPPORT_MESSAGE[Support.FRAMED], err);
      } else {
        this._fail('request', (err && err.message) || String(err), err);
      }
      return false;
    }

    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDisconnect);
    return this.connect();
  }

  /* Reconnecting to an already-permitted device needs no fresh user gesture. */
  async connect() {
    if (!this.device) return false;
    if (this.state === 'connecting') return false;
    this._setState('connecting');

    try {
      this.server = await this.device.gatt.connect();
      const services = {
        ess:    await this.server.getPrimaryService(ESS_SERVICE),
        vendor: await this.server.getPrimaryService(VENDOR_SERVICE),
      };

      this.characteristics.clear();

      // Strictly sequential. The GATT queue serialises these anyway, and firing
      // them concurrently is a known source of flaky
      // "NetworkError: GATT operation already in progress" on Android.
      for (const ch of CHANNELS) {
        const chr = await services[ch.service].getCharacteristic(ch.uuid);
        this.characteristics.set(ch.key, chr);

        chr.addEventListener('characteristicvaluechanged', ev => {
          this._publish(ch.key, ev.target.value);
        });
        await chr.startNotifications();

        // Seed the UI. Notifications fire only on change, so a stable probe in
        // stable soil would otherwise leave us with six blanks indefinitely.
        this._publish(ch.key, await chr.readValue());
      }

      this._setState('connected');
      return true;
    } catch (err) {
      const name = err && err.name;
      if (name === 'SecurityError') {
        this._fail('optional-services',
          'The browser refused access to the vendor service. It must be named in optionalServices — this is the usual cause of "it connects but I get nothing".', err);
      } else if (name === 'NetworkError') {
        this._fail('link',
          'Lost the link while setting up. The probe may have moved out of range, or something else took its single connection.', err);
      } else {
        this._fail('connect', (err && err.message) || String(err), err);
      }
      this.disconnect();
      return false;
    }
  }

  _publish(key, dataView) {
    let value;
    try {
      value = decode(key, dataView);
    } catch (err) {
      this._emit('log', { message: 'Ignored malformed ' + key + ': ' + err.message });
      return;
    }
    this._emit('reading', { key, value, at: Date.now() });
  }

  _onDisconnect() {
    this.characteristics.clear();
    this.server = null;
    this._setState('disconnected');
  }

  disconnect() {
    try {
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();   // fires gattserverdisconnected
      } else {
        this._onDisconnect();
      }
    } catch {
      this._onDisconnect();
    }
  }

  forget() {
    this.disconnect();
    if (this.device) this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
    this.device = null;
  }

  _fail(kind, message, cause) {
    this._emit('error', { kind, message, cause });
  }
}

/* ---------- demo source ---------- */
/*
 * Nothing here has been run against real hardware yet, and the UI still has to
 * be reviewable without a probe on the desk. This walks plausible values, drops
 * into the not-known state every so often, and emits exactly the same events as
 * NpkDevice — including the rule that a change in any channel notifies all six.
 */
export class DemoDevice extends EventTarget {
  constructor() {
    super();
    this.state = 'disconnected';
    this._timer = null;
    this._tick = 0;
    this._base = { temperature: 27.4, moisture: 38.2, nitrogen: 142, phosphorus: 61, potassium: 210, conductivity: 1180 };
  }

  get name() { return 'NPK-DEM0'; }
  get canReconnect() { return true; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', { state });
  }

  async requestAndConnect() { return this.connect(); }

  async connect() {
    this._setState('connecting');
    await new Promise(r => setTimeout(r, 400));
    this._setState('connected');
    this._sweep();
    this._timer = setInterval(() => this._sweep(), 2000);   // the firmware's own period
    return true;
  }

  _sweep() {
    this._tick += 1;
    // Two windows in eight, the probe "goes away" — the state clients most
    // often forget to handle, and the one worth putting in front of a reviewer
    // often enough that they actually see it.
    const dead = this._tick % 8 >= 6;
    const at = Date.now();
    for (const ch of CHANNELS) {
      let value = null;
      if (!dead) {
        const wobble = Math.sin(this._tick / 7 + ch.key.length) * (ch.max - ch.min) * 0.01;
        value = this._base[ch.key] + wobble + (Math.random() - 0.5) * (ch.decimals ? 0.2 : 2);
        value = Math.min(ch.max, Math.max(ch.min, value));
        value = ch.decimals ? Math.round(value * 10) / 10 : Math.round(value);
      }
      this._emit('reading', { key: ch.key, value, at });
    }
  }

  disconnect() {
    clearInterval(this._timer);
    this._timer = null;
    this._setState('disconnected');
  }

  forget() { this.disconnect(); }
}
