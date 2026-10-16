import { Ollama, type Message, type Tool, type ToolCall } from "ollama/browser";
import { fetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { addMessage, getMessages, getSetting } from "./db";
import { EMPTY_PROFILE, RESEARCHER, teacherPrompt, type Profile } from "./prompts";
import { salvageToolCall } from "./quiz";

export const DEFAULT_HOST = "https://ollama.com";
export const DEFAULT_MODEL = "gpt-oss:120b";

/** Tools answered by the student through a card in the chat; the loop stops and resumes on answer. */
export const INTERACTIVE = new Set(["quiz", "ask_user_question"]);

export async function getClient() {
  const host = await getSetting("host", DEFAULT_HOST);
  const key = await invoke<string | null>("get_api_key");
  return new Ollama({ host, fetch, headers: key ? { Authorization: `Bearer ${key}` } : {} });
}

export async function listModels(): Promise<string[]> {
  const { models } = await (await getClient()).list();
  return models.map((m) => m.name).sort();
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } as Tool["function"]["parameters"] },
});

const optionsSchema = {
  type: "array",
  description: "Options to choose from. Each has a display label and a short stable value.",
  items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
};

const TEACHER_TOOLS: Tool[] = [
  fn(
    "quiz",
    "Ask the student a GRADED multiple-choice question with a known correct answer. The app grades it, reveals the answer and your explanation, and returns the result (correct / wrong / dont_know, plus an optional note). Use it to probe their level and to check each node landed. An 'I don't know' choice is added automatically - never add your own.",
    {
      question: { type: "string" },
      details: { type: "string", description: "Optional context shown under the question." },
      options: optionsSchema,
      correctAnswer: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "The `value` of the correct option, or an array of values when multiSelect is true.",
      },
      explanation: { type: "string", description: "Why the correct answer is correct. Shown only after they answer." },
      multiSelect: { type: "boolean", description: "True only when more than one option is correct." },
      shuffle: { type: "boolean", description: "Defaults to true. Set false only when option order is meaningful." },
    },
    ["question", "options", "correctAnswer", "explanation"],
  ),
  fn(
    "ask_user_question",
    "Ask the student an UNGRADED question: their goal, a preference, a direction, or okaying the plan. With options they pick (and can add their own text); without options it's free text.",
    {
      question: { type: "string" },
      details: { type: "string", description: "Optional context shown under the question." },
      options: optionsSchema,
      multiSelect: { type: "boolean" },
    },
    ["question"],
  ),
  fn(
    "research",
    "Verify facts or scope a topic. A research assistant searches the web and returns a sourced brief. It has no access to this conversation, so the question must be self-contained.",
    { question: { type: "string" } },
    ["question"],
  ),
];

const WEB_TOOLS: Tool[] = [
  fn("web_search", "Search the web.", { query: { type: "string" } }, ["query"]),
  fn("web_fetch", "Fetch a web page's main content.", { url: { type: "string" } }, ["url"]),
];

export type Live = { content: string; thinking: string; status?: string };

/** Streams one assistant turn, accumulating content, thinking, and tool calls. */
async function chatOnce(
  client: Ollama,
  model: string,
  messages: Message[],
  tools: Tool[],
  signal: AbortSignal,
  onDelta?: (m: Message) => void,
): Promise<Message> {
  const stream = await client
    .chat({ model, messages, tools, stream: true, think: true })
    .catch((e) => {
      if (!String(e?.message ?? e).includes("does not support thinking")) throw e;
      return client.chat({ model, messages, tools, stream: true });
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

async function research(client: Ollama, model: string, question: string, signal: AbortSignal): Promise<string> {
  const messages: Message[] = [
    { role: "system", content: RESEARCHER },
    { role: "user", content: question },
  ];
  // ponytail: fixed step cap; make it a setting if research regularly needs more
  for (let step = 0; step < 10; step++) {
    const msg = await chatOnce(client, model, messages, WEB_TOOLS, signal);
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
}

/** The next tool call of the latest assistant turn that has no result yet (results are stored in call order). */
export function pendingCall(messages: Message[]): ToolCall | undefined {
  const i = messages.findLastIndex((m) => m.role === "assistant");
  const calls = messages[i]?.tool_calls;
  if (!calls?.length) return undefined;
  const answered = messages.slice(i + 1).filter((m) => m.role === "tool").length;
  return calls[answered];
}

/** Adds the student's message, closing out any tool calls a stopped run left unanswered. */
export async function addUserMessage(sessionId: string, content: string) {
  let call: ToolCall | undefined;
  while ((call = pendingCall(await getMessages(sessionId)))) {
    await addMessage(sessionId, { role: "tool", tool_name: call.function.name, content: "Cancelled: the student moved on." });
  }
  await addMessage(sessionId, { role: "user", content });
}

/**
 * Drives a session forward until the model finishes its turn or asks the student something.
 * Everything is persisted as it happens, so a run can stop at any point and resume later.
 */
export async function runAgent(
  sessionId: string,
  signal: AbortSignal,
  onLive: (live: Live | null) => void,
  onSaved: () => Promise<void>,
) {
  const client = await getClient();
  const model = await getSetting("model", DEFAULT_MODEL);
  const system = teacherPrompt(await getSetting<Profile>("profile", EMPTY_PROFILE));
  try {
    for (;;) {
      const messages = await getMessages(sessionId);
      const call = pendingCall(messages);
      if (call) {
        if (INTERACTIVE.has(call.function.name)) return;
        let content: string;
        if (call.function.name === "research") {
          const question = String(call.function.arguments.question ?? "");
          onLive({ content: "", thinking: "", status: `Researching: ${question}` });
          try {
            content = await research(client, model, question, signal);
          } catch (e) {
            if (signal.aborted) throw e;
            content = `Research failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else {
          content = `Unknown tool: ${call.function.name}`;
        }
        await addMessage(sessionId, { role: "tool", tool_name: call.function.name, content });
        await onSaved();
        continue;
      }
      if (messages.at(-1)?.role === "assistant") return;

      let partial: Message | null = null;
      try {
        const msg = salvageToolCall(
          await chatOnce(client, model, [{ role: "system", content: system }, ...messages], TEACHER_TOOLS, signal, (m) => {
            partial = m;
            onLive({ content: m.content, thinking: m.thinking ?? "" });
          }),
        );
        await addMessage(sessionId, msg);
        await onSaved();
        onLive(null);
      } catch (e) {
        // Keep whatever streamed before a stop, minus half-formed tool calls.
        const p = partial as Message | null;
        if (signal.aborted && p && (p.content || p.thinking)) {
          await addMessage(sessionId, { role: "assistant", content: p.content, thinking: p.thinking });
          await onSaved();
        }
        throw e;
      }
    }
  } finally {
    onLive(null);
  }
}
