// YouTube URL and WebVTT parsing. Plain Node, no network.

import assert from "node:assert/strict";
import {
  cuesToSrt,
  cuesToText,
  parseVtt,
  videoIdFromUrl,
  youtubeSlug,
} from "../src/youtube.ts";

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

const VTT = `\uFEFFWEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000 align:start position:0%
Hello <c>there</c>.

00:00:02.000 --> 00:00:04.000
Hello there.

00:00:04.000 --> 00:00:06.000
BLIP is online.
`;

check("video ids are accepted from the common YouTube URL shapes", () => {
  assert.equal(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromUrl("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoIdFromUrl("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

check("non-YouTube hosts and bad ids are refused", () => {
  assert.equal(videoIdFromUrl("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(videoIdFromUrl("not a url"), null);
  assert.equal(videoIdFromUrl("https://youtu.be/short"), null);
});

check("VTT cues are parsed, BOM and tags removed", () => {
  const cues = parseVtt(VTT);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, "Hello there.");
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 2);
  assert.equal(cues[2].text, "BLIP is online.");
});

check("plain text collapses the repeated auto-caption cue", () => {
  assert.equal(cuesToText(parseVtt(VTT)), "Hello there.\nBLIP is online.");
});

check("SRT uses comma milliseconds and numbering", () => {
  const srt = cuesToSrt(parseVtt(VTT));
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nHello there\./);
  assert.match(srt, /3\n00:00:04,000 --> 00:00:06,000\nBLIP is online\./);
});

check("slugs are filename safe", () => {
  assert.equal(youtubeSlug("A Video: Title / Part 2!"), "a-video-title-part-2");
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`youtube: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`youtube: ${checks} checks passed`);
