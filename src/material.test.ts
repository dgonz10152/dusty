import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MATERIAL_CHARS, materialError, materialMessage } from "./material.ts";

test("materialMessage wraps every file under its name", () => {
  const msg = materialMessage([
    { name: "lec1.pdf", content: "  Sets  " },
    { name: "Pasted text", content: "Midterm covers ch. 1-3" },
  ]);
  assert.match(msg, /<course_material>\n# file: lec1\.pdf\n\nSets\n\n# file: Pasted text\n\nMidterm covers ch\. 1-3\n<\/course_material>$/);
});

test("materialError rejects material past the limit", () => {
  assert.equal(materialError([{ name: "a", content: "x".repeat(MAX_MATERIAL_CHARS) }]), null);
  assert.match(materialError([{ name: "a", content: "x".repeat(MAX_MATERIAL_CHARS) }, { name: "b", content: "y" }])!, /too much/);
});
