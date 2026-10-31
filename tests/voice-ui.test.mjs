// The shipped console must carry voice input and read-aloud. Static checks on
// the built UI so a rebuild cannot silently drop them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
let checks = 0;
const failures = [];
function check(name, fn) {
  checks++;
  try {
    fn();
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
function has(text, label) {
  assert.equal(html.includes(text), true, `missing ${label || JSON.stringify(text)}`);
}

check("the composer has a microphone button", () => {
  has('id="micBtn"', "mic button");
  has("toggleRecord", "recorder toggle");
  has("transcribeRecording", "transcription call");
  has("/api/voice/transcribe", "transcription endpoint");
  has("getUserMedia", "microphone capture");
});

check("assistant replies can be read aloud", () => {
  has("speakLog", "read-aloud handler");
  has("/api/voice/speak", "speech endpoint");
  has("Listen</button>", "listen label");
  has("splitSpeech", "long-reply chunking");
});

check("audio artifacts keep the inline player", () => {
  has("playAudio", "artifact audio player");
  has('class="fplay"', "play control");
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`voice-ui: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`voice-ui: ${checks} checks passed`);
