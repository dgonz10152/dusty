import { Ollama, type Message as OllamaMessage } from "ollama/browser";
import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { getSetting } from "../db";
import type { ChatRequest, CompleteRequest, Message, Provider, ResearchRequest, Tool, TranscribeRequest } from "../llm";

export const DEFAULT_HOST = "https://ollama.com";

async function getClient() {
  const host = await getSetting("host", DEFAULT_HOST);
  const key = await invoke<string | null>("get_api_key");
  return new Ollama({ host, fetch, headers: key ? { Authorization: `Bearer ${key}` } : {} });
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const WEB_TOOLS: Tool[] = [
  fn("web_search", "Search the web.", { query: { type: "string" } }, ["query"]),
  fn("web_fetch", "Fetch a web page's main content.", { url: { type: "string" } }, ["url"]),
];

async function chatOnce(client: Ollama, { model, system, messages, tools, signal, onDelta }: ChatRequest): Promise<Message> {
  const req = { model, messages: [{ role: "system", content: system }, ...messages] as OllamaMessage[], tools, stream: true as const };
  const stream = await client.chat({ ...req, think: true }).catch((e) => {
    if (!String(e?.message ?? e).includes("does not support thinking")) throw e;
    return client.chat(req);
  });
  const stop = () => stream.abort();
  signal.addEventListener("abort", stop);
  const msg: Message = { role: "assistant", content: "", thinking: "", tool_calls: [] };
  try {
    for await (const part of stream) {
      msg.content += part.message.content ?? "";
      msg.thinking += part.message.thinking ?? "";
      if (part.message.tool_calls) msg.tool_calls!.push(...part.message.tool_calls);
      onDelta?.(msg);
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
  return msg;
}

const clip = (s: string, n = 12000) => (s.length > n ? `${s.slice(0, n)}\n...[truncated]` : s);

export const ollama: Provider = {
  id: "ollama",
  label: "Ollama",

  async listModels() {
    const { models } = await (await getClient()).list();
    return models.map((m) => m.name).sort();
  },

  async setupHint() {
    return (await invoke<string | null>("get_api_key")) ? null : "Add your Ollama API key in Settings to get started";
  },

  async chat(req) {
    return chatOnce(await getClient(), req);
  },

  async research({ model, system, question, signal }: ResearchRequest) {
    const client = await getClient();
    const messages: Message[] = [{ role: "user", content: question }];
    // ponytail: fixed step cap; make it a setting if research regularly needs more
    for (let step = 0; step < 10; step++) {
      const msg = await chatOnce(client, { model, system, messages, tools: WEB_TOOLS, signal });
      messages.push(msg);
      if (!msg.tool_calls?.length) return msg.content;
      for (const call of msg.tool_calls) {
        let content: string;
        try {
          const args = call.function.arguments;
          if (call.function.name === "web_search") content = JSON.stringify(await client.webSearch({ query: String(args.query) }));
          else if (call.function.name === "web_fetch") content = JSON.stringify(await client.webFetch({ url: String(args.url) }));
          else content = `Unknown tool: ${call.function.name}`;
        } catch (e) {
          content = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        messages.push({ role: "tool", tool_name: call.function.name, content: clip(content) });
      }
    }
    return messages.at(-1)?.content || "Research hit its step limit without a conclusion.";
  },

  async complete({ model, system, prompt }: CompleteRequest) {
    const res = await (await getClient()).chat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    return res.message.content;
  },

  async transcribe({ model, system, image }: TranscribeRequest) {
    const client = await getClient();
    const { capabilities } = await client.show({ model });
    if (!capabilities?.includes("vision")) throw new Error(`${model} can't read images`);
    const res = await client.chat({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Transcribe this picture.", images: [image.data] },
      ],
    });
    return res.message.content;
  },
};
