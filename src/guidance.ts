import type { Message, ToolCall } from "./llm.ts";
import { hintPrompt } from "./prompts.ts";
import { parseQuizArgs } from "./quiz.ts";

/** A tool-free view keeps the pending quiz intact and works with every provider. */
export function guidanceMessages(messages: Message[], quiz: ToolCall, question: string, hintIndex: number): Message[] {
  const context: Message[] = [];
  for (const m of messages) {
    if (m.content) context.push({ role: m.role === "tool" ? "user" : m.role, content: m.role === "tool" ? `Previous ${m.tool_name} result: ${m.content}` : m.content });
    for (const call of m.tool_calls ?? []) {
      const hints = call === quiz ? call.hints?.slice(0, hintIndex) : call.hints;
      for (const h of hints ?? []) {
        if (!h.answer) continue;
        context.push({ role: "user", content: h.question }, { role: "assistant", content: h.answer });
      }
    }
  }
  context.push({ role: "user", content: hintPrompt(parseQuizArgs(quiz.function.arguments), question) });
  return context;
}
