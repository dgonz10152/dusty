import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolCall } from "./llm.ts";
import { guidanceMessages } from "./guidance.ts";
import { canCompleteLesson, gradeQuiz, isAssisted, parseQuizArgs } from "./quiz.ts";
import { HINTER, teacherPrompt, EMPTY_PROFILE } from "./prompts.ts";

const args = { question: "Which planet is closest?", options: ["Mercury", "Venus"], correctAnswer: "Mercury", explanation: "Orbit radius" };

test("guidance includes lesson and previous discussion without unresolved tool calls", () => {
  const quiz: ToolCall = { function: { name: "quiz", arguments: args }, hints: [
    { question: "What does orbit mean?", answer: "A path around another body." },
    { question: "And radius?", answer: "", status: "pending" },
  ] };
  const messages: Message[] = [{ role: "user", content: "My course uses heliocentric coordinates" }, { role: "assistant", content: "Let's consider distances.", tool_calls: [quiz] }];
  const before = JSON.stringify(messages);
  const context = guidanceMessages(messages, quiz, "And radius?", 1);
  assert.equal(JSON.stringify(messages), before);
  assert.ok(context.every((m) => !m.tool_calls && m.role !== "tool"));
  const text = context.map((m) => m.content).join("\n");
  assert.match(text, /heliocentric/);
  assert.match(text, /A path around another body/);
  assert.match(text, /And radius\?/);
  assert.match(text, /never reveal/);
  assert.match(HINTER, /Never state, confirm, or rule out any option/);
  assert.match(teacherPrompt(EMPTY_PROFILE), /SAME skill/);
});

test("assisted, legacy, interrupted, wrong and missing checks cannot complete a lesson", () => {
  const hints = [{ question: "Explain the concept", answer: "", status: "stopped" as const }];
  const quiz = parseQuizArgs(args);
  const helped = gradeQuiz(quiz, ["Mercury"], "", hints);
  assert.equal(helped.result, "correct");
  assert.equal(helped.assisted, true);
  assert.equal(isAssisted({ ...helped, assisted: undefined }), true);
  const tool = (result: unknown): Message => ({ role: "tool", tool_name: "quiz", content: JSON.stringify(result) });
  assert.equal(canCompleteLesson([]), false);
  assert.equal(canCompleteLesson([tool(helped)]), false);
  assert.equal(canCompleteLesson([tool({ ...helped, assisted: undefined })]), false);
  assert.equal(canCompleteLesson([tool(gradeQuiz(quiz, ["Venus"]))]), false);
  assert.equal(canCompleteLesson([tool(gradeQuiz(quiz, null))]), false);
  assert.equal(canCompleteLesson([tool(helped), tool(gradeQuiz(quiz, ["Mercury"]))]), true);
  assert.equal(canCompleteLesson([{ role: "tool", tool_name: "quiz", content: "Cancelled" }]), false);
});
