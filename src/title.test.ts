import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, titleInput } from "./title.ts";

test("cleanTitle strips what models wrap titles in", () => {
  assert.equal(cleanTitle('"Bayes\' rule"'), "Bayes' rule");
  assert.equal(cleanTitle("**Title:** CS 161 Midterm 2.\n\nHope that helps!"), "CS 161 Midterm 2");
  assert.equal(cleanTitle("<think>hmm</think>\n# Eigenvalues"), "Eigenvalues");
  assert.equal(cleanTitle("x".repeat(80)).length, 60);
  assert.equal(cleanTitle("   "), "");
});

test("titleInput uses the first message, the material, and the first written reply", () => {
  const input = titleInput(
    [
      { role: "user", content: "Here's what my exam covers." },
      { role: "assistant", content: "" },
      { role: "assistant", content: "When is the exam?" },
    ],
    ["lec1.pdf", "board.heic"],
  );
  assert.equal(input, "Student: Here's what my exam covers.\n\nCourse material they attached: lec1.pdf, board.heic\n\nTutor: When is the exam?");
});
