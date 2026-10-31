// Chat attachment rules: display names, stored paths, the model preamble, and
// the validator the message route trusts. Plain Node.

import assert from "node:assert/strict";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentPreamble,
  parseAttachments,
  safeAttachmentName,
  storedAttachmentPath,
} from "../src/attachments.ts";

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
    console.log("  FAIL " + name);
  }
}

check("a display name keeps the basename and strips controls", () => {
  assert.equal(safeAttachmentName("../../report.pdf"), "report.pdf");
  assert.equal(safeAttachmentName("C:\\Users\\me\\notes.txt"), "notes.txt");
  assert.equal(safeAttachmentName("  spaced name.png  "), "spaced name.png");
  assert.equal(safeAttachmentName("bad\u0000name.txt"), "badname.txt");
  assert.equal(safeAttachmentName(""), null);
  assert.equal(safeAttachmentName(".."), null);
  assert.equal(safeAttachmentName(42), null);
});

check("the stored path is unique, ASCII and under uploads/", () => {
  const first = storedAttachmentPath("My Report Final.PDF", 1);
  const second = storedAttachmentPath("My Report Final.PDF", 1);
  assert.match(first, /^uploads\/[a-z0-9._-]+\.pdf$/);
  assert.notEqual(first, second);
  assert.ok(first.endsWith(".pdf"));
  assert.match(storedAttachmentPath("简历.docx", 2), /^uploads\/file-[a-z0-9]+\.docx$/);
});

check("the parser accepts a well-formed list and refuses a hostile one", () => {
  const good = parseAttachments([
    { name: "notes.txt", path: "uploads/notes-abc.txt", bytes: 12 },
  ]);
  assert.deepEqual(good, [{ name: "notes.txt", path: "uploads/notes-abc.txt", bytes: 12 }]);
  assert.deepEqual(parseAttachments(undefined), []);
  assert.equal(parseAttachments("nope"), null);
  assert.equal(
    parseAttachments([{ name: "x", path: "../etc/passwd", bytes: 1 }]),
    null
  );
  assert.equal(
    parseAttachments([{ name: "x", path: "elsewhere/x.txt", bytes: 1 }]),
    null
  );
  assert.equal(
    parseAttachments([
      { name: "x", path: "uploads/a.txt", bytes: MAX_ATTACHMENT_BYTES + 1 },
    ]),
    null
  );
  assert.equal(
    parseAttachments([
      { name: "x", path: "uploads/a.txt", bytes: 1 },
      { name: "y", path: "uploads/a.txt", bytes: 1 },
    ]),
    null
  );
  assert.equal(parseAttachments(new Array(11).fill({ name: "x", path: "uploads/a.txt", bytes: 1 })), null);
});

check("the preamble names absolute paths and leaves the user text intact", () => {
  const text = attachmentPreamble(
    "summarize this",
    [
      { name: "report.pdf", path: "uploads/report-ab12.pdf", bytes: 2048 },
      { name: "notes.txt", path: "uploads/notes-cd34.txt", bytes: 10 },
    ],
    "/home/user"
  );
  assert.match(text, /^summarize this/);
  assert.match(text, /\/home\/user\/uploads\/report-ab12\.pdf \(report\.pdf, 2048 bytes\)/);
  assert.match(text, /2 files/);
  assert.equal(attachmentPreamble("plain", [], "/home/user"), "plain");
});

if (failures.length) {
  for (const failure of failures) console.error("  FAIL " + failure);
  process.exit(1);
}
console.log("attachments: passed");
