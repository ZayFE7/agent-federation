// Pure media helpers: byte sniffing, dimensions, WAV duration, and subtitle
// formatting. No network and no Durable Object. Plain Node.

import assert from "node:assert/strict";
import {
  buildSrt,
  buildVtt,
  detectAudio,
  detectImage,
  formatTimestamp,
  imageDimensions,
  wavDuration,
} from "../src/media-client.ts";

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

function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width, height) {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function wav(seconds) {
  const sampleRate = 24000;
  const channels = 1;
  const bits = 16;
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = Math.round(byteRate * seconds);
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (start, value) => {
    for (let i = 0; i < value.length; i += 1) bytes[start + i] = value.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

check("PNG is detected with its dimensions", () => {
  const bytes = png(1024, 768);
  assert.deepEqual(detectImage(bytes), { mime: "image/png", ext: "png" });
  assert.deepEqual(imageDimensions(bytes), { width: 1024, height: 768 });
});

check("JPEG is detected with its dimensions", () => {
  const bytes = jpeg(1264, 848);
  assert.deepEqual(detectImage(bytes), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(imageDimensions(bytes), { width: 1264, height: 848 });
});

check("unknown image bytes fail closed to bin", () => {
  assert.deepEqual(detectImage(new Uint8Array([1, 2, 3])), {
    mime: "application/octet-stream",
    ext: "bin",
  });
  assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), null);
});

check("WAV is detected and its duration is measured", () => {
  const bytes = wav(2.5);
  assert.deepEqual(detectAudio(bytes), { mime: "audio/wav", ext: "wav" });
  const duration = wavDuration(bytes);
  assert.ok(duration !== null && Math.abs(duration - 2.5) < 0.02, String(duration));
});

check("MP3, OGG, and M4A signatures are detected", () => {
  assert.equal(detectAudio(new Uint8Array([0x49, 0x44, 0x33, 0x04])).ext, "mp3");
  assert.equal(detectAudio(new Uint8Array([0x4f, 0x67, 0x67, 0x53])).ext, "ogg");
  const m4a = new Uint8Array(12);
  m4a.set([0x66, 0x74, 0x79, 0x70], 4);
  assert.equal(detectAudio(m4a).ext, "m4a");
});

check("timestamps format for SRT and VTT", () => {
  assert.equal(formatTimestamp(3661.5, true), "01:01:01,500");
  assert.equal(formatTimestamp(3661.5, false), "01:01:01.500");
});

check("SRT and VTT are built from segments", () => {
  const segments = [
    { start: 0, end: 2.9, text: " Hello there. " },
    { start: 3.36, end: 4.48, text: " BLIP is online. " },
  ];
  const srt = buildSrt(segments);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,900\nHello there\./);
  assert.match(srt, /2\n00:00:03,360 --> 00:00:04,480\nBLIP is online\./);
  const vtt = buildVtt(segments);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:02\.900\nHello there\./);
});

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`media: ${failures.length} of ${checks} failed`);
  process.exit(1);
}
console.log(`media: ${checks} checks passed`);
