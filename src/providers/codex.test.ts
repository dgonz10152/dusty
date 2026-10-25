import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCodexEvent } from "./codex.ts";
import { parseToolBlock } from "./toolProtocol.ts";
import type { Message } from "../llm.ts";

test("Codex item snapshots replace text without duplicating the final reply", () => {
  const msg: Message = { role: "assistant", content: "" };
  for (const type of ["item.updated", "item.completed", "item.completed"]) {
    applyCodexEvent(msg, { type, item: { id: "1", type: "agent_message", text: 'Check.\n```tool\n{"name":"quiz","arguments":{"question":"2+2?"}}\n```' } });
  }
  assert.equal(parseToolBlock(msg).content, "Check.");
  assert.equal(parseToolBlock(msg).tool_calls?.[0].function.name, "quiz");
  applyCodexEvent(msg, { type: "item.completed", item: { id: "2", type: "command_execution", text: "hidden" } });
  assert.match(msg.content, /^Check\./);
});
