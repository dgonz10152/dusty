import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeQuiz, parseQuizArgs, salvageToolCall } from "./quiz.ts";

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

test("salvageToolCall turns a trailing quiz JSON block into the tool call", () => {
  const args = { question: "Which is polite?", options: [{ label: "Je voudrais", value: "correct" }], correctAnswer: "correct", explanation: "e" };
  const content = `### Quick check\nPick one.\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n`;
  const fixed = salvageToolCall({ role: "assistant", content });
  assert.equal(fixed.content, "### Quick check\nPick one.");
  assert.deepEqual(fixed.tool_calls, [{ function: { name: "quiz", arguments: args } }]);

  // left alone: JSON that isn't a question, JSON mid-reply, and turns that already called a tool
  const other = "```json\n{\"name\": \"x\"}\n```";
  assert.equal(salvageToolCall({ role: "assistant", content: other }).tool_calls, undefined);
  const mid = `\`\`\`json\n${JSON.stringify(args)}\n\`\`\`\nMore text.`;
  assert.equal(salvageToolCall({ role: "assistant", content: mid }).tool_calls, undefined);
  const called = { role: "assistant", content, tool_calls: [{ function: { name: "research", arguments: {} } }] };
  assert.equal(salvageToolCall(called), called);
});
