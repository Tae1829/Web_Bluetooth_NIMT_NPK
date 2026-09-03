/*
 * Decoding tests. Run with: node test/decode.test.mjs
 *
 * These are the cheapest possible insurance against the failure this interface
 * is most likely to produce in the field: a client that shows -327.7 C and
 * 65535 mg/kg the moment a probe cable comes loose. No browser needed — decode()
 * only touches DataView.
 */

import assert from 'node:assert/strict';
import { decode, CHANNELS } from '../npk-ble.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

/* Little-endian two-byte value, as it arrives on the wire. */
function wire(lo, hi) {
  return new DataView(Uint8Array.from([lo, hi]).buffer);
}

function u16(value) {
  return wire(value & 0xff, (value >> 8) & 0xff);
}

test('temperature is signed, scaled by 100', () => {
  assert.equal(decode('temperature', u16(2740)), 27.4);
  assert.equal(decode('temperature', u16(0x10000 - 1250)), -12.5);
  assert.equal(decode('temperature', u16(0)), 0);
});

test('temperature 0x8000 is not-known, not -327.68', () => {
  assert.equal(decode('temperature', u16(0x8000)), null);
});

test('temperature 0xFFFF is a real reading of -0.01, not not-known', () => {
  // Only 0x8000 is the sentinel for the signed channel. Treating 0xFFFF as
  // not-known here would silently swallow a legitimate sub-zero reading.
  assert.equal(decode('temperature', u16(0xffff)), -0.01);
});

test('moisture is unsigned, scaled by 100', () => {
  assert.equal(decode('moisture', u16(3820)), 38.2);
  assert.equal(decode('moisture', u16(10000)), 100);
});

test('moisture 0x8000 is a real reading of 327.68, not not-known', () => {
  // Out of range, and the UI flags it as such — but it is not the sentinel.
  assert.equal(decode('moisture', u16(0x8000)), 327.68);
});

test('every unsigned channel treats 0xFFFF as not-known', () => {
  for (const ch of CHANNELS) {
    if (ch.key === 'temperature') continue;
    assert.equal(decode(ch.key, u16(0xffff)), null, ch.key);
  }
});

test('nutrients and conductivity are raw integers', () => {
  assert.equal(decode('nitrogen', u16(142)), 142);
  assert.equal(decode('phosphorus', u16(0)), 0);
  assert.equal(decode('potassium', u16(2999)), 2999);
  assert.equal(decode('conductivity', u16(20000)), 20000);
});

test('bytes are read little-endian', () => {
  // 0x0102 little-endian is 0x0201 = 513. Big-endian would give 258 and every
  // reading would be wrong in a way that still looks plausible.
  assert.equal(decode('nitrogen', wire(0x02, 0x01)), 0x0102);
});

test('a short value is rejected rather than misread', () => {
  const short = new DataView(Uint8Array.from([0x01]).buffer);
  assert.throws(() => decode('nitrogen', short), /expected 2 bytes/);
});

test('every channel in the table has a decoder', () => {
  for (const ch of CHANNELS) {
    assert.doesNotThrow(() => decode(ch.key, u16(1)), ch.key);
  }
});

if (failures.length) {
  for (const f of failures) console.error('FAIL  ' + f.name + '\n      ' + f.message);
  console.error('\n' + failures.length + ' failed, ' + passed + ' passed');
  process.exit(1);
}
console.log(passed + ' passed');
