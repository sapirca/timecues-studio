# LED shows from TimeCues annotations

Audio-reactive LEDs (WLED's sound-reactive mode, LedFx, an FFT in a FastLED
sketch) react to loudness after it happens. They can't know a drop is coming,
ramp through a 16-bar buildup, or treat one roar differently from the beat
around it. A TimeCues annotation knows all of that ahead of time. These tools
play it on LEDs, in time with the song.

| What you annotate | What the LEDs do |
|---|---|
| **Sections** (boundaries) | The whole strip sits in the section's color, dimmed |
| **Spans** | A chase in the span's color. One step per tick of the span's **Pulse** (a beat if none is set) |
| **Cues** | A full-strip flash in the cue's color that fades out |

Colors are the ones you see in TimeCues: a section takes its type's color, and
a cue or span takes its own color if it has one, otherwise its layer's color.

Two players use the same show, so it looks the same on either:

- **`wled-play.mjs`** drives a WLED controller over its JSON API. No firmware
  changes, nothing to install beyond Node 18+.
- **`fastled/TimeCuesShow/`** is an Arduino sketch for FastLED. The show is
  compiled into the board (AVR, ESP32, ESP8266, RP2040, Teensy).

## 1. Export the annotations

Use either of these:

- **From the app:** open the song → ⋯ → **Export annotations…** → format
  **TimeCues JSON**. Unzip the download.
- **From the command line:**
  `node tools/export-timing-files.mjs <song-slug> --annotator <you>` writes
  `exports/timing/<slug>/<slug>_annotations.json`.

Both work as `<export>` below: a file, several files, or a folder.

## 2. Choose the lanes

```bash
node tools/led/led-show.mjs <export> --list
```

By default the show uses your sections plus every hand-made cues and spans
layer. Lanes made by detectors are left out. To pick lanes yourself, name
them. For example, to flash on every sound in a lyrics layer:

```bash
--lanes "Boundaries - Phrases,Sounds - Animals,xLights"
```

## 3a. WLED

```bash
node tools/led/wled-play.mjs <export> --host 192.168.1.50
```

Start the song, then press Enter on its first beat. Or let the tool play the
song itself with `--audio song.mp3` (needs `ffplay`, or `afplay` on a Mac).

- `--start 180` begins at 3:00.
- `--brightness 96` caps the master brightness (the default is 128).
- `--segment 1` drives another segment.
- `--latency 40` sends each change 40 ms early, if the strip lags over Wi-Fi.
- `--dry-run` prints every state change without sending any.

**Your own effects and presets.** A map file sends a WLED state of your own
when a cue's or span's label matches a pattern (case-insensitive):

```json
{
  "Shockwave": { "ps": 3 },
  "^Matrix":   { "seg": [{ "fx": 66, "sx": 200 }] }
}
```

```bash
node tools/led/wled-play.mjs <export> --host wled.local --map my-effects.json
```

The player saves the device's state before the show and puts it back
afterwards, including when you stop it with Ctrl-C.

WLED's effect speed isn't in milliseconds, so a span's chase speed is an
approximation: a faster pulse gives a faster chase.

## 3b. FastLED (Arduino)

```bash
node tools/led/led-show.mjs <export> --header tools/led/fastled/TimeCuesShow/timecues_show.h
```

Open `fastled/TimeCuesShow/TimeCuesShow.ino` and set `DATA_PIN`, `NUM_LEDS`
and `LED_TYPE`, then upload it. Open the Serial Monitor at 115200 baud, start
the song, and send any character on its first beat. You can also wire a button
to `START_PIN`.

The `timecues_show.h` that ships here is a 30-second example, so the sketch
builds as is.

The show is stored in flash: each event takes 12 bytes, so a song with a few
hundred cues fits easily, even on an Uno.

## Show file for your own code

```bash
node tools/led/led-show.mjs <export> --json show.json
```

This writes one flat list of events with `kind`, `start_ms`, `end_ms`, `label`,
`color` and, for spans, `step_ms`. Use it in TouchDesigner, Python, or a
microcontroller of your own.

## Tests

```bash
node --test tools/led/led-show.test.mjs
```

The tests check the show builder on the example in `example/`. They play the
WLED player against a fake WLED server on localhost, checking timing and that
the device's state is restored. They also check that the shipped header
matches the example and that the section colors match the app.
