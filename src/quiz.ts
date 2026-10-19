import type { Message } from "./llm";

export type Option = { label: string; value: string };

export type QuizArgs = {
  question: string;
  details?: string;
  options: Option[];
  correct: string[];
  explanation: string;
  multiSelect: boolean;
  shuffle: boolean;
};

export type QuizResult = {
  /** `from_basics`: the student asked to be taught from the basics instead of answering. */
  result: "correct" | "wrong" | "dont_know" | "from_basics";
  selected: string[];
  correctAnswer: string[];
  note?: string;
};

// Models send loose shapes: options as strings or JSON strings, correctAnswer as a label instead of a value.
export function parseQuizArgs(raw: Record<string, unknown>): QuizArgs {
  const options = normalizeOptions(raw.options);
  const correctRaw = maybeJson(raw.correctAnswer);
  const correct = (Array.isArray(correctRaw) ? correctRaw : [correctRaw]).map((c) => {
    const s = String(c);
    return (options.find((o) => o.value === s) ?? options.find((o) => o.label === s))?.value ?? s;
  });
  return {
    question: String(raw.question ?? ""),
    details: raw.details ? String(raw.details) : undefined,
    options,
    correct,
    explanation: String(raw.explanation ?? ""),
    multiSelect: raw.multiSelect === true || raw.multiSelect === "true",
    shuffle: raw.shuffle !== false && raw.shuffle !== "false",
  };
}

export function normalizeOptions(raw: unknown): Option[] {
  const list = maybeJson(raw);
  if (!Array.isArray(list)) return [];
  return list.map((o) =>
    typeof o === "object" && o !== null
      ? { label: String((o as Option).label ?? (o as Option).value), value: String((o as Option).value ?? (o as Option).label) }
      : { label: String(o), value: String(o) },
  );
}

function maybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** `selected === null` means "I don't know". Multi-select is an exact-set match. */
export function gradeQuiz(args: QuizArgs, selected: string[] | null, note?: string): QuizResult {
  const base = { correctAnswer: args.correct, ...(note?.trim() && { note: note.trim() }) };
  if (selected === null) return { result: "dont_know", selected: [], ...base };
  const want = new Set(args.correct);
  const ok = selected.length === want.size && selected.every((s) => want.has(s));
  return { result: ok ? "correct" : "wrong", selected, ...base };
}

// A model sometimes writes a quiz or question as a JSON block ending its reply instead of calling the tool
// (seen after a ```deps block primed it). Turn that trailing block back into the real tool call.
export function salvageToolCall(msg: Message): Message {
  if (msg.tool_calls?.length) return msg;
  const m = /```(?:json)?\s*\n(\{[\s\S]*\})\s*\n```\s*$/.exec(msg.content);
  if (!m) return msg;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(m[1]);
  } catch {
    return msg;
  }
  if (typeof args.question !== "string" || !args.options) return msg;
  const name = "correctAnswer" in args ? "quiz" : "ask_user_question";
  return { ...msg, content: msg.content.slice(0, m.index).trimEnd(), tool_calls: [{ function: { name, arguments: args } }] };
}
