import { test } from "node:test";
import assert from "node:assert/strict";
import { addCourse } from "./prompts.ts";

test("addCourse appends a new course once", () => {
  assert.equal(addCourse("", "Chem 20A"), "Chem 20A");
  assert.equal(addCourse("CS 31, Math 32A", " Chem 20A "), "CS 31, Math 32A, Chem 20A");
  assert.equal(addCourse("CS 31, chem 20a", "Chem 20A"), "CS 31, chem 20a");
  assert.equal(addCourse("CS 31", "  "), "CS 31");
});
