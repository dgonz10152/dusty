import { addMessage, getAttachments, getMaterial, getMessages, getSession, getSetting, listSessions, renameSession, setDone, type Session } from "./db";
import { latestMap } from "./graph";
import type { Message, Tool, ToolCall } from "./llm";
import { loadImage, materialMessage, withMaterial, type Material } from "./material";
import { childContext, EMPTY_PROFILE, examPrompt, RESEARCHER, teacherPrompt, TITLER, TRANSCRIBER, type Profile } from "./prompts";
import { cleanTitle, titleInput } from "./title";
import { getProvider, readModel } from "./providers";
import { salvageToolCall } from "./quiz";

/** Tools answered by the student through a card in the chat; the loop stops and resumes on answer. */
export const INTERACTIVE = new Set(["quiz", "ask_user_question"]);

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const optionsSchema = {
  type: "array",
  description: "Options to choose from. Each has a display label and a short stable value.",
  items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
};

const QUIZ = fn(
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
);

const ASK = fn(
  "ask_user_question",
  "Ask the student an UNGRADED question: their goal, a preference, a direction, or okaying the plan. With options they pick (and can add their own text); without options it's free text.",
  {
    question: { type: "string" },
    details: { type: "string", description: "Optional context shown under the question." },
    options: optionsSchema,
    multiSelect: { type: "boolean" },
  },
  ["question"],
);

const RESEARCH = fn(
  "research",
  "Verify facts or scope a topic. A research assistant searches the web and returns a sourced brief. It has no access to this conversation, so the question must be self-contained.",
  { question: { type: "string" } },
  ["question"],
);

const COMPLETE = fn(
  "complete_lesson",
  "Mark this lesson done on the student's exam map. Call it once, right after the final quiz-check of this lesson's concept lands.",
  {},
  [],
);

const TEACHER_TOOLS = [QUIZ, ASK, RESEARCH];

/**
 * The prompt and tools a session runs with: a plain lesson, an exam, or one of an exam's lessons.
 * `inherited` is the exam's material, which an exam's lesson reads ahead of its own conversation.
 */
async function setup(sessionId: string): Promise<{ system: string; tools: Tool[]; inherited: Material[] }> {
  const profile = await getSetting<Profile>("profile", EMPTY_PROFILE);
  const session = await getSession(sessionId);
  if (session?.kind === "exam") return { system: examPrompt(profile), tools: [ASK, RESEARCH], inherited: [] };
  const exam = session?.parent_id ? await getSession(session.parent_id) : undefined;
  if (!exam) return { system: teacherPrompt(profile), tools: TEACHER_TOOLS, inherited: [] };
  const done = new Set((await listSessions()).filter((s) => s.parent_id === exam.id && s.done && s.node_id).map((s) => s.node_id!));
  const context = childContext(exam.title, latestMap(await getMessages(exam.id)), session!.node_id, done);
  return { system: `${teacherPrompt(profile)}\n\n${context}`, tools: [...TEACHER_TOOLS, COMPLETE], inherited: await getMaterial(exam.id) };
}

/** Replaces the placeholder title (the first message) with a short AI summary, like ChatGPT does. */
async function nameSession(session: Session, messages: Message[]) {
  const { provider: providerId, model } = await readModel();
  const provider = getProvider(providerId);
  const names = (await getAttachments(session.id)).map((a) => a.name);
  const raw = await provider.complete({ model: provider.quickModel ?? model, system: TITLER, prompt: titleInput(messages, names) });
  const title = cleanTitle(raw);
  if (title) await renameSession(session.id, title);
}

/** Turns a picture of course material into text with the selected model. */
export async function transcribeImage(file: File): Promise<string> {
  const { provider, model } = await readModel();
  const text = await getProvider(provider).transcribe({ model, system: TRANSCRIBER, image: await loadImage(file) });
  return `[Transcribed from a picture]\n\n${text}`;
}

/** A turn in progress. `tool` is a tool call the model has started writing but not finished. */
export type Live = { content: string; thinking: string; status?: string; tool?: string };

/** The next tool call of the latest assistant turn that has no result yet (results are stored in call order). */
export function pendingCall(messages: Message[]): ToolCall | undefined {
  const i = messages.findLastIndex((m) => m.role === "assistant");
  const calls = messages[i]?.tool_calls;
  if (!calls?.length) return undefined;
  const answered = messages.slice(i + 1).filter((m) => m.role === "tool").length;
  return calls[answered];
}

/** Adds the student's message, closing out any tool calls a stopped run left unanswered. Returns its id. */
export async function addUserMessage(sessionId: string, content: string): Promise<number> {
  let call: ToolCall | undefined;
  while ((call = pendingCall(await getMessages(sessionId)))) {
    await addMessage(sessionId, { role: "tool", tool_name: call.function.name, content: "Cancelled: the student moved on." });
  }
  return addMessage(sessionId, { role: "user", content });
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
  const { provider: providerId, model } = await readModel();
  const provider = getProvider(providerId);
  const { system, tools, inherited } = await setup(sessionId);
  const session = await getSession(sessionId);
  // Material is sent on every turn but never stored in the conversation.
  const preamble: Message[] = inherited.length ? [{ role: "user", content: materialMessage(inherited) }] : [];
  const material = await getMaterial(sessionId);
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
            content = await provider.research({ model, system: RESEARCHER, question, signal });
          } catch (e) {
            if (signal.aborted) throw e;
            content = `Research failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else if (call.function.name === "complete_lesson") {
          await setDone(sessionId, true);
          content = "Marked done on the exam map.";
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
          await provider.chat({
            model,
            system,
            messages: [...preamble, ...withMaterial(messages, material)],
            tools,
            signal,
            onDelta: (m) => {
              partial = m;
              onLive({ content: m.content, thinking: m.thinking ?? "", tool: m.tool_calls?.at(-1)?.function.name });
            },
          }),
        );
        await addMessage(sessionId, msg);
        // Titled once, after the first reply. An exam's lessons keep their map node's name.
        if (session && !session.parent_id && !messages.some((m) => m.role === "assistant")) {
          nameSession(session, [...messages, msg]).then(onSaved, (e) => console.warn("Couldn't title the session", e));
        }
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
