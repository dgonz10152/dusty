import { toolProtocol, toTranscript, parseToolBlock, streamingView } from "./toolProtocol.ts";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Message, Provider } from "../llm";

// Each turn is one stateless `claude -p` run (see `claude_run` in src-tauri/src/lib.rs). Dusty owns the agent loop
// because interactive tools pause it until the student answers, so Claude Code gets no native tools for teaching.
// The model calls a tool by ending its reply with a ```tool block, which is parsed back into `tool_calls`.

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
  const stop = () => {
    gotResult();
    return invoke("claude_stop", { runId });
  };
  signal.addEventListener("abort", stop);
  try {
    await invoke("claude_run", { runId, kind, model, system, input, onEvent: onEventChannel });
    // Channel messages can land after the command returns, and a successful run always ends with a result.
    await resultArrived;
    signal.throwIfAborted();
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
  quickModel: "haiku",

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

  async complete({ model, system, prompt }) {
    return (await run("teach", model, system, prompt, new AbortController().signal)).result ?? "";
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
