import type { Message, Tool, ToolCall } from "../llm.ts";

const FENCE = "```";
const TOOL_FENCE = `${FENCE}tool`;

export function toolProtocol(tools: Tool[]): string {
  const specs = tools.map(
    (t) => `## ${t.function.name}\n\n${t.function.description}\n\nArguments (JSON Schema): ${JSON.stringify(t.function.parameters)}`,
  );
  return `
# Calling tools

You call a tool by ending your reply with one fenced block tagged \`tool\` that holds a JSON object with the tool's \`name\` and \`arguments\`:

${TOOL_FENCE}
{"name": "ask_user_question", "arguments": {"question": "What do you want to be able to do once you understand this?"}}
${FENCE}

- That block is how the student gets a card, so every quiz and question goes through it.
- At most one tool call per reply, and it must be the very last thing in the reply. Stop writing right after the closing fence.
- The conversation so far is given to you as a transcript: \`<student>\` is the student, \`<tutor>\` is you, and \`<tool_result>\` is what a tool returned. Write only the tutor's next reply, without any of those tags.

Available tools:

${specs.join("\n\n")}`.trim();
}

const toolBlock = (call: ToolCall) =>
  `${TOOL_FENCE}\n${JSON.stringify({ name: call.function.name, arguments: call.function.arguments })}\n${FENCE}`;

export function toTranscript(messages: Message[]): string {
  const turns = messages.flatMap((m) => {
    if (m.role === "user") return [`<student>\n${m.content}\n</student>`];
    if (m.role === "tool") return [`<tool_result name="${m.tool_name ?? ""}">\n${m.content}\n</tool_result>`];
    if (m.role === "assistant") {
      const body = [m.content.trim(), ...(m.tool_calls ?? []).map(toolBlock)].filter(Boolean).join("\n\n");
      return [`<tutor>\n${body}\n</tutor>`];
    }
    return [];
  });
  return `${turns.join("\n\n")}\n\nWrite the tutor's next reply.`;
}

/** Moves the first ```tool block into `tool_calls`; anything after it is dropped. */
export function parseToolBlock(msg: Message): Message {
  const m = /```tool[ \t]*\n([\s\S]*?)\n[ \t]*```/.exec(msg.content);
  if (!m) return msg;
  let call: { name?: unknown; arguments?: unknown };
  try {
    call = JSON.parse(m[1]);
  } catch {
    return msg;
  }
  if (typeof call.name !== "string") return msg;
  const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {};
  return {
    ...msg,
    content: msg.content.slice(0, m.index).trimEnd(),
    tool_calls: [{ function: { name: call.name, arguments: args } }],
  };
}

/**
 * What the student should see mid-stream: the text without the half-written tool block, plus the tool's
 * name (with empty arguments) once it's known, so the UI can say what's coming.
 */
export function streamingView(msg: Message): Message {
  const i = msg.content.indexOf(TOOL_FENCE);
  if (i < 0) return { ...msg };
  const name = /"name"\s*:\s*"([^"]+)"/.exec(msg.content.slice(i))?.[1];
  return {
    ...msg,
    content: msg.content.slice(0, i).trimEnd(),
    tool_calls: name ? [{ function: { name, arguments: {} } }] : [],
  };
}

