import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../llm.ts";
import { applyEvent, parseToolBlock, streamingView, toTranscript } from "./claudeCode.ts";

const quiz = { name: "quiz", arguments: { question: "2+2?", options: [{ label: "4", value: "4" }], correctAnswer: "4", explanation: "Sum." } };
const reply = (content: string): Message => ({ role: "assistant", content });

test("a tool block becomes a tool call", () => {
  const msg = parseToolBlock(reply(`Let's check.\n\n\`\`\`tool\n${JSON.stringify(quiz)}\n\`\`\`\nignored trailing text`));
  assert.equal(msg.content, "Let's check.");
  assert.deepEqual(msg.tool_calls, [{ function: quiz }]);
});

test("replies without a valid tool block are left alone", () => {
  for (const content of ["Plain text.", "```tool\n{not json}\n```", '```tool\n{"arguments":{}}\n```', '```json\n{"name":"quiz"}\n```']) {
    assert.deepEqual(parseToolBlock(reply(content)), reply(content));
  }
});

test("transcript round-trips the tutor's own tool calls", () => {
  const text = toTranscript([
    { role: "user", content: "Teach me addition" },
    { role: "assistant", content: "Quick check.", thinking: "secret", tool_calls: [{ function: quiz }] },
    { role: "tool", tool_name: "quiz", content: '{"result":"correct"}' },
  ]);
  assert.match(text, /<student>\nTeach me addition\n<\/student>/);
  assert.match(text, /<tool_result name="quiz">\n\{"result":"correct"\}\n<\/tool_result>/);
  assert.doesNotMatch(text, /secret/);
  const tutor = /<tutor>\n([\s\S]*?)\n<\/tutor>/.exec(text)![1];
  assert.deepEqual(parseToolBlock(reply(tutor)).tool_calls, [{ function: quiz }]);
});

test("stream events fold into the message, and a half-written tool block stays hidden", () => {
  const msg: Message = { role: "assistant", content: "", thinking: "", tool_calls: [] };
  const delta = (delta: object) => ({ type: "stream_event", event: { type: "content_block_delta", delta } });
  applyEvent(msg, delta({ type: "thinking_delta", thinking: "hmm" }));
  applyEvent(msg, delta({ type: "text_delta", text: "Hi.\n\n```tool\n{\"na" }));
  applyEvent(msg, delta({ type: "signature_delta", signature: "x" }));
  applyEvent(msg, { type: "system" });
  assert.equal(msg.thinking, "hmm");
  assert.deepEqual(streamingView(msg), { ...msg, content: "Hi.", tool_calls: [] });

  applyEvent(msg, delta({ type: "text_delta", text: 'me": "quiz", "arguments": {"quest' }));
  assert.deepEqual(streamingView(msg).tool_calls, [{ function: { name: "quiz", arguments: {} } }]);
  assert.equal(streamingView({ ...msg, content: "No tools here." }).content, "No tools here.");
});
