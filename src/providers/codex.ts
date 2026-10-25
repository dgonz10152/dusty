import { Channel, invoke } from "@tauri-apps/api/core";
import type { ImageData, Message, Provider } from "../llm.ts";
import { parseToolBlock, streamingView, toolProtocol, toTranscript } from "./toolProtocol.ts";

export type CodexEvent = {
  type: string;
  item?: { id: string; type: string; text?: string };
};

/** Codex updates contain the whole item, not a text delta. */
export function applyCodexEvent(msg: Message, ev: CodexEvent) {
  if ((ev.type === "item.updated" || ev.type === "item.completed") && ev.item?.type === "agent_message") {
    msg.content = ev.item.text ?? "";
  }
}

async function run(
  kind: "teach" | "research" | "transcribe",
  model: string,
  system: string,
  input: string,
  signal: AbortSignal,
  onDelta?: (msg: Message) => void,
  image?: ImageData,
): Promise<Message> {
  signal.throwIfAborted();
  const runId = crypto.randomUUID();
  const msg: Message = { role: "assistant", content: "", thinking: "", tool_calls: [] };
  let active = true;
  const onEvent = new Channel<string>((line) => {
    if (!active) return;
    try {
      applyCodexEvent(msg, JSON.parse(line));
      onDelta?.(streamingView(msg));
    } catch { /* Ignore non-JSON diagnostics. The command returns the authoritative result. */ }
  });
  const stop = () => { void invoke("codex_stop", { runId }).catch(() => {}); };
  signal.addEventListener("abort", stop);
  try {
    // The return value avoids waiting forever for a missing or delayed channel event.
    msg.content = await invoke<string>("codex_run", {
      runId, kind, model, system, input, onEvent,
      image: image ? { mime: image.mime, bytes: Array.from(atob(image.data), (c) => c.charCodeAt(0)) } : null,
    });
    signal.throwIfAborted();
    return msg;
  } catch (e) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw new Error(String(e));
  } finally {
    active = false;
    signal.removeEventListener("abort", stop);
  }
}

export const codex: Provider = {
  id: "codex",
  label: "Codex",
  async listModels() {
    return invoke<string[]>("codex_models");
  },
  async setupHint() {
    return await invoke<boolean>("codex_available") ? null : "Install Codex CLI, run codex login in a terminal, then restart Dusty.";
  },
  async chat({ model, system, messages, tools, signal, onDelta }) {
    return parseToolBlock(await run("teach", model, `${system}\n\n${toolProtocol(tools)}`, toTranscript(messages), signal, onDelta));
  },
  async research({ model, system, question, signal }) {
    return (await run("research", model, system, question, signal)).content;
  },
  async complete({ model, system, prompt }) {
    return (await run("teach", model, system, prompt, new AbortController().signal)).content;
  },
  async transcribe({ model, system, image }) {
    return (await run("transcribe", model, system, "Transcribe this picture.", new AbortController().signal, undefined, image)).content;
  },
};
