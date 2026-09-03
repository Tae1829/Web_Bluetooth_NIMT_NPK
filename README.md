# NPK Soil Probe — Web Bluetooth client

A static, offline-capable read-only client for the Intronics NIMT NPK soil probe
(ESP32-C3, NimBLE peripheral). It connects over Web Bluetooth, subscribes to all
six characteristics and displays them, including the probe's own "no reading"
state.

Built from the GATT service reference. The firmware is canonical:
`components/ble_reporter/ble_reporter.c` and `ble_reporter.h`. Where this app and
the firmware disagree, the firmware is right.

## Files

| File | What it is |
| --- | --- |
| `npk-ble.js` | Protocol layer. UUIDs, decoding, connect/notify sequence, capability checks. No DOM. |
| `app.js` | UI. Turns events into pixels and failures into sentences. |
| `index.html`, `app.css` | Shell and styling. Light and dark. |
| `sw.js` | Service worker. Cache-first precache of the whole app. |
| `manifest.webmanifest`, `icons/` | Installable PWA. |
| `test/decode.test.mjs` | Decoding tests, `node test/decode.test.mjs`. |

No build step, no dependencies. Plain ES modules — serve the folder as-is.

## Running it

Web Bluetooth needs a **secure context**: HTTPS, or `localhost`. There is no way
around this, and it is the reason a page served by the probe itself over plain
HTTP at `192.168.4.1` can never use Web Bluetooth.

### Desktop Chrome or Edge

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`. `localhost` counts as secure, so this is
enough for full end-to-end testing with a probe on the bench.

### On an Android phone, against real hardware

The cheapest path is to reverse-forward the port over USB, so the phone also
sees the app on `localhost` and the secure-context rule is satisfied without a
certificate:

```bash
adb reverse tcp:8000 tcp:8000
```

Leave `python -m http.server 8000` running on the PC, then open
`http://localhost:8000` in Chrome on the phone.

### GitHub Pages

Push the folder to a repository and turn Pages on for that branch. Nothing else
is needed: no build, no workflow, no framework. All paths are relative, so a
project site under `/<repo>/` works exactly as a user site does, and the service
worker's scope follows the same subdirectory.

`.nojekyll` is committed so Pages serves the files as they are rather than
running them through Jekyll.

## iPhones and iPads: use Bluefy

Safari has no Web Bluetooth, and Chrome and Edge on iOS are Safari underneath,
so none of them can reach the probe. [Bluefy](https://apps.apple.com/app/id1492822055)
is a browser that adds Web Bluetooth on iOS, over HTTPS, and the same URL works
in it unchanged.

The app detects iOS specifically. Instead of a flat "unsupported" it shows an
**Open in Bluefy** button, which hands the page over through Bluefy's custom URL
scheme:

```
bluefy://https://your-host.example/npk/
```

The whole https URL goes after `bluefy://`, scheme included — a bare host or a
path alone does not open. (Pattern taken from the Cow Barn Sensor interface,
which does the same thing from a separate bridge page.)

Detection uses two signals: no `navigator.bluetooth`, and an iOS user agent. It
also checks for `Bluefy` in the user agent, so someone already inside Bluefy is
never offered a link back to Bluefy.

Underneath the button is a **Copy the address instead** fallback, for when iOS
has nothing registered for the scheme because Bluefy is not installed — tapping
a `bluefy://` link then does nothing at all, with no error. The fine print links
to the App Store.

Two further consequences worth knowing:

- **No home-screen install on iOS.** That is a Safari-only feature, and Bluefy
  is not Safari. Bookmark the page inside Bluefy instead.
- **Offline is less certain there.** The service worker is registered the same
  way, but Bluefy is a WKWebView app and its service-worker support has not been
  confirmed on the handsets you will actually issue. Before a field trip, open
  the page in Bluefy with the phone in flight mode and check that it still
  loads. If it does not, that is worth knowing before someone is standing in a
  field.

## What it will not do

- **Write anything.** Every characteristic is `READ | NOTIFY`. Configuration,
  WiFi credentials and calibration are reachable only from the probe's own web
  app, deliberately, because this link is unpaired and unencrypted.

## Behaviour worth knowing

- **Notifications fire only on change.** A stable probe in stable soil goes
  quiet. The app says so under the readings rather than letting silence read as
  a dropped connection.
- **`0x8000` / `0xFFFF` mean "no reading",** not −327.7 °C and 65535 mg/kg. The
  probe reports these after ten seconds without an answer from the RS485 bus.
  Cards turn amber and say *Probe not answering*.
- **One connection at a time.** If a phone app is holding it, the probe stops
  advertising and is simply absent from the chooser. The "probe isn't in the
  list" panel in the UI covers this and the other two ordinary reasons.
- **`optionalServices` must name the vendor service.** The filter matches on
  `0x181A`, so without it `getPrimaryService()` throws `SecurityError` — the
  usual cause of "it connects but I get nothing". Handled, and reported in those
  words if it ever happens.
- **GATT setup is strictly sequential.** Six characteristics, one at a time. The
  GATT queue serialises them anyway and concurrent calls are a known source of
  flaky `NetworkError: GATT operation already in progress` on Android.

## Demo mode

The link at the bottom of the page runs a simulated probe: plausible values on
the firmware's own two-second period, dropping into the not-known state for two
windows in every eight. It lets the display — including the "probe not
answering" state — be reviewed without hardware, and it works on browsers with
no Web Bluetooth at all.

## Tests

```bash
node test/decode.test.mjs
```

Ten assertions over `decode()`: endianness, the signed/unsigned split, and the
two sentinel values. Cheap insurance against the failure this interface is most
likely to produce in the field — a client that shows −327.7 °C the moment a
cable comes loose.

## Bring-up order

Each step rules out a class of problem, so do them in order.

1. nRF Connect or LightBlue sees `NPK-XXXXXX`. If not, the problem is the probe,
   not this app.
2. Temperature and Humidity show sensible values with units in that app, with no
   configuration. Confirms the encoding end to end.
3. The four vendor characteristics show their user descriptions.
4. This page is on HTTPS or `localhost`. Check before debugging anything else.
   On an iPhone or iPad, check you are in Bluefy and not Safari.
5. Connect here; all six cards populate.
6. **Unplug the probe** and confirm the cards say *No reading* rather than
   −327.7 °C. The step most likely to be skipped and most likely to come back
   from the field.

## Open items

- Nothing here has been run against real hardware. UUIDs and encodings come from
  the firmware source, but first bring-up may still turn up surprises.
- No Device Information Service on the probe yet (manufacturer, model, firmware
  revision). It would be cheap to add and useful at incoming inspection; if it
  lands, add a header line here reading it.
- Nothing has been tried in Bluefy yet. The `bluefy://` handoff follows a
  pattern already working in the Cow Barn Sensor interface, but this app's own
  banner has only been exercised against a simulated iOS browser.
- English only, deliberately. Thai labels were considered and traded off for a
  more professional look.
- Live monitoring only, deliberately. Logging and history are MQTT's job.
