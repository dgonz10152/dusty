import { Channel, invoke } from "@tauri-apps/api/core";
import type { Message, Provider, Tool, ToolCall } from "../llm";

// Each turn is one stateless `claude -p` run (see `claude_run` in src-tauri/src/lib.rs). Dusty owns the agent loop
// because interactive tools pause it until the student answers, so Claude Code gets no native tools for teaching.
// The model calls a tool by ending its reply with a ```tool block, which is parsed back into `tool_calls`.

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

type StreamEvent = {
  type: string;
  event?: { type: string; delta?: { type: string; text?: string; thinking?: string } };
  is_error?: boolean;
  result?: string;
};

/** Folds one stream-json event into the message being built. */
export function applyEvent(msg: Message, ev: StreamEvent) {
  const d = ev.type === "stream_event" && ev.event?.type === "content_block_delta" ? ev.event.delta : undefined;
  if (d?.type === "text_delta") msg.content += d.text ?? "";
  else if (d?.type === "thinking_delta") msg.thinking += d.thinking ?? "";
}

/** Runs `claude` once and resolves with the final result event. */
async function run(
  kind: "teach" | "research" | "transcribe",
  model: string,
  system: string,
  input: string,
  signal: AbortSignal,
  onEvent?: (ev: StreamEvent) => void,
): Promise<StreamEvent> {
  signal.throwIfAborted();
  const runId = crypto.randomUUID();
  let result: StreamEvent | undefined;
  let gotResult!: () => void;
  const resultArrived = new Promise<void>((r) => (gotResult = r));
  const onEventChannel = new Channel<string>((line) => {
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "result") {
      result = ev;
      gotResult();
    } else onEvent?.(ev);
  });
  const stop = () => invoke("claude_stop", { runId });
  signal.addEventListener("abort", stop);
  try {
    await invoke("claude_run", { runId, kind, model, system, input, onEvent: onEventChannel });
    // Channel messages can land after the command returns, and a successful run always ends with a result.
    await resultArrived;
  } catch (e) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw new Error(result?.is_error && result.result ? result.result : String(e));
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (result!.is_error) throw new Error(result!.result || "Claude Code failed");
  return result!;
}

export const claudeCode: Provider = {
  id: "claude-code",
  label: "Claude Code",

  async listModels() {
    if (!(await invoke<boolean>("claude_available"))) throw new Error("Claude Code isn't installed");
    return ["opus", "sonnet", "haiku"];
  },

  async setupHint() {
    return null;
  },

  async chat({ model, system, messages, tools, signal, onDelta }) {
    const msg: Message = { role: "assistant", content: "", thinking: "", tool_calls: [] };
    await run("teach", model, `${system}\n\n${toolProtocol(tools)}`, toTranscript(messages), signal, (ev) => {
      applyEvent(msg, ev);
      onDelta?.(streamingView(msg));
    });
    return parseToolBlock(msg);
  },

  async research({ model, system, question, signal }) {
    return (await run("research", model, system, question, signal)).result ?? "";
  },

  async transcribe({ model, system, image }) {
    // The picture goes in as a stream-json user message, which is the only way print mode takes images.
    const input = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mime, data: image.data } },
          { type: "text", text: "Transcribe this picture." },
        ],
      },
    });
    return (await run("transcribe", model, system, `${input}\n`, new AbortController().signal)).result ?? "";
  },
};
