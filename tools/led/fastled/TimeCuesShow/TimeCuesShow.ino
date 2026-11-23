// TimeCuesShow — play a song's TimeCues annotations on an addressable LED strip.
//
//   section  the whole strip sits in the section's color, dimmed
//   span     a chase in the span's color, one step per pulse tick
//   cue      a full-strip flash in the cue's color that fades out
//
// 1. Export the song's annotations from TimeCues (see tools/led/README.md).
// 2. Write the show into this folder:
//      node tools/led/led-show.mjs <export> --header tools/led/fastled/TimeCuesShow/timecues_show.h
// 3. Set the strip below, upload, open the Serial Monitor at 115200 baud.
// 4. Start the song, and send any character (or press START_PIN) on its first beat.
//
// The timecues_show.h shipped here is a 30-second example, so the sketch builds as is.
// Works on any board FastLED supports (AVR, ESP32, ESP8266, RP2040, Teensy).

#include <FastLED.h>
#include "timecues_show.h"

#define DATA_PIN      6
#define NUM_LEDS      60
#define LED_TYPE      WS2812B
#define COLOR_ORDER   GRB
#define BRIGHTNESS    96      // 0-255; keep it low on USB power
#define SECTION_LEVEL 70      // how bright a section's base color is, 0-255
#define CHASE_GAP     4       // a span lights every CHASE_GAP-th LED
#define START_PIN     -1      // a button to GND that starts the show; -1 = serial only
#define START_AT_MS   0       // begin mid-song, e.g. 180000 to start at 3:00

CRGB leds[NUM_LEDS];
uint32_t t0 = 0;
bool running = false;

static TcEvent eventAt(uint16_t i) {
  TcEvent e;
  memcpy_P(&e, &TC_EVENTS[i], sizeof e);   // events live in flash
  return e;
}

static bool startRequested() {
  bool go = false;
  while (Serial.available()) { Serial.read(); go = true; }
#if START_PIN >= 0
  if (digitalRead(START_PIN) == LOW) { go = true; delay(30); }
#endif
  return go;
}

void setup() {
  FastLED.addLeds<LED_TYPE, DATA_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
#if START_PIN >= 0
  pinMode(START_PIN, INPUT_PULLUP);
#endif
  Serial.begin(115200);
  FastLED.clear(true);
  Serial.print(F("TimeCuesShow: "));
  Serial.print(TC_EVENT_COUNT);
  Serial.println(F(" events. Send any character on the song's first beat."));
}

void loop() {
  if (startRequested()) {                    // start, or restart from the top
    t0 = millis() - START_AT_MS;
    running = true;
    Serial.println(F("go"));
  }
  if (!running) return;

  const uint32_t t = millis() - t0;
  if (t > TC_SONG_MS) {
    running = false;
    FastLED.clear(true);
    Serial.println(F("done"));
    return;
  }

  // What is playing now. Events are sorted by start, so stop at the first future one.
  CRGB base = CRGB::Black;
  TcEvent span, cue;
  bool hasSpan = false, hasCue = false;
  for (uint16_t i = 0; i < TC_EVENT_COUNT; i++) {
    const TcEvent e = eventAt(i);
    if (e.start_ms > t) break;
    if (t >= e.end_ms) continue;
    if (e.kind == 0) base = CRGB(e.r, e.g, e.b);
    else if (e.kind == 1) { span = e; hasSpan = true; }
    else { cue = e; hasCue = true; }
  }

  base.nscale8_video(SECTION_LEVEL);
  fill_solid(leds, NUM_LEDS, base);

  if (hasSpan && span.step_ms > 0) {         // step_ms 0 = a span marked silent
    const uint32_t step = (t - span.start_ms) / span.step_ms;
    const CRGB c(span.r, span.g, span.b);
    for (uint16_t i = 0; i < NUM_LEDS; i++) {
      if ((i + CHASE_GAP - step % CHASE_GAP) % CHASE_GAP == 0) leds[i] = c;
    }
  }

  if (hasCue) {                              // flash, fading out over the cue's length
    const uint32_t len = cue.end_ms - cue.start_ms;
    const uint8_t level = len ? (uint8_t)(255UL * (cue.end_ms - t) / len) : 0;
    const CRGB c(cue.r, cue.g, cue.b);
    for (uint16_t i = 0; i < NUM_LEDS; i++) leds[i] = blend(leds[i], c, level);
  }

  FastLED.show();
}
