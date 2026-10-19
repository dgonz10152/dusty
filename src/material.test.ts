import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MATERIAL_CHARS, materialError, materialMessage, withMaterial } from "./material.ts";

test("materialMessage wraps every file under its name", () => {
  const msg = materialMessage([
    { name: "lec1.pdf", content: "  Sets  " },
    { name: "Pasted text", content: "Midterm covers ch. 1-3" },
  ]);
  assert.match(msg, /<course_material>\n# file: lec1\.pdf\n\nSets\n\n# file: Pasted text\n\nMidterm covers ch\. 1-3\n<\/course_material>$/);
});

test("materialError rejects material past the limit", () => {
  assert.equal(materialError(MAX_MATERIAL_CHARS), null);
  assert.match(materialError(MAX_MATERIAL_CHARS + 1)!, /too much/);
});

test("withMaterial puts files on the message they were attached to", () => {
  const messages = [
    { id: 1, role: "user", content: "Teach me sets" },
    { id: 2, role: "assistant", content: "Sure" },
    { id: 3, role: "user", content: "Explain Q2" },
  ];
  const out = withMaterial(messages, [{ message_id: 3, name: "hw.pdf", content: "Q2: union" }]);
  assert.deepEqual(out.slice(0, 2), messages.slice(0, 2));
  assert.match(out[2].content, /^Here is my course material[\s\S]*# file: hw\.pdf\n\nQ2: union\n<\/course_material>\n\nExplain Q2$/);
});
