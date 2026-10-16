import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeQuiz, parseQuizArgs } from "./quiz.ts";

test("grading", () => {
  const single = parseQuizArgs({ question: "q", options: ["Mercury", "Venus"], correctAnswer: "Mercury", explanation: "e" });
  assert.equal(gradeQuiz(single, ["Mercury"]).result, "correct");
  assert.equal(gradeQuiz(single, ["Venus"]).result, "wrong");
  assert.equal(gradeQuiz(single, null, " unsure ").result, "dont_know");
  assert.equal(gradeQuiz(single, null, " unsure ").note, "unsure");

  // correctAnswer given as a label, options as a JSON string
  const multi = parseQuizArgs({
    question: "q",
    options: JSON.stringify([{ label: "Belize", value: "bz" }, { label: "Niue", value: "nu" }, { label: "Peru", value: "pe" }]),
    correctAnswer: ["Belize", "nu"],
    multiSelect: true,
    explanation: "e",
  });
  assert.deepEqual(multi.correct, ["bz", "nu"]);
  assert.equal(gradeQuiz(multi, ["nu", "bz"]).result, "correct");
  assert.equal(gradeQuiz(multi, ["bz"]).result, "wrong");
  assert.equal(gradeQuiz(multi, ["bz", "nu", "pe"]).result, "wrong");
});
