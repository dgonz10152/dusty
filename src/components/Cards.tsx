import { useMemo, useState } from "react";
import { Check, Lightbulb, X } from "lucide-react";
import Markdown from "./Markdown";
import { gradeQuiz, normalizeOptions, parseQuizArgs, type Option, type QuizResult } from "../quiz";

type CardProps = {
  args: Record<string, unknown>;
  /** The stored tool result (JSON) once answered. */
  result?: string;
  onAnswer: (content: string) => void;
};

// Seeded so a quiz keeps its order across re-renders and app restarts.
function shuffled<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parse<T>(json?: string): T | undefined {
  try {
    return json ? (JSON.parse(json) as T) : undefined;
  } catch {
    return undefined;
  }
}

function useSelection(multi: boolean) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (v: string) =>
    setSelected((s) => (multi ? (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]) : [v]));
  return [selected, toggle] as const;
}

// "reveal" shows the answer after "I don't know" - not a win, so it isn't green.
type Mark = "right" | "wrong" | "missed" | "reveal";

function OptionRow({
  option,
  multi,
  checked,
  mark,
  disabled,
  onToggle,
}: {
  option: Option;
  multi: boolean;
  checked: boolean;
  mark?: Mark;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={`option ${checked ? "checked" : ""} ${mark ?? ""}`}>
      <input type={multi ? "checkbox" : "radio"} checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="option-label">
        <Markdown text={option.label} />
      </span>
      {mark === "right" || mark === "missed" ? <Check size={16} className="mark" /> : null}
      {mark === "wrong" ? <X size={16} className="mark" /> : null}
      {mark === "reveal" ? <Lightbulb size={16} className="mark" /> : null}
    </label>
  );
}

export function QuizCard({ args: raw, result, onAnswer }: CardProps) {
  const args = useMemo(() => parseQuizArgs(raw), [raw]);
  const options = useMemo(
    () => (args.shuffle ? shuffled(args.options, args.question) : args.options),
    [args],
  );
  const answer = parse<QuizResult>(result);
  const [selected, toggle] = useSelection(args.multiSelect);
  const [note, setNote] = useState("");
  const submit = (pick: string[] | null) => onAnswer(JSON.stringify(gradeQuiz(args, pick, note)));

  const markFor = (v: string): Mark | undefined => {
    if (!answer) return undefined;
    const isCorrect = args.correct.includes(v);
    if (answer.result === "dont_know") return isCorrect ? "reveal" : undefined;
    const picked = answer.selected.includes(v);
    if (isCorrect) return picked ? "right" : "missed";
    return picked ? "wrong" : undefined;
  };

  return (
    <div className={`card ${answer ? `answered ${answer.result}` : ""}`}>
      <div className="card-kind">{args.multiSelect ? "Quiz - select all that apply" : "Quiz"}</div>
      <div className="card-question">
        <Markdown text={args.question} />
      </div>
      {args.details && (
        <div className="card-details">
          <Markdown text={args.details} />
        </div>
      )}
      <div className="options">
        {options.map((o) => (
          <OptionRow
            key={o.value}
            option={o}
            multi={args.multiSelect}
            checked={answer ? answer.selected.includes(o.value) : selected.includes(o.value)}
            mark={markFor(o.value)}
            disabled={!!answer}
            onToggle={() => toggle(o.value)}
          />
        ))}
      </div>
      {answer ? (
        <div className="card-feedback">
          <div className="verdict">
            {answer.result === "correct" ? "Correct" : answer.result === "wrong" ? "Not quite" : "You didn't know - that's useful to know"}
          </div>
          {answer.note && <div className="card-note">Your note: {answer.note}</div>}
          <Markdown text={args.explanation} />
        </div>
      ) : (
        <>
          <input
            className="card-input"
            placeholder="Add a note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="card-actions">
            <button className="btn ghost" onClick={() => submit(null)}>
              I don't know
            </button>
            <button className="btn primary" disabled={!selected.length} onClick={() => submit(selected)}>
              Submit
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type QuestionAnswer = { selected: string[]; text?: string };

export function QuestionCard({ args: raw, result, onAnswer }: CardProps) {
  const options = useMemo(() => normalizeOptions(raw.options), [raw]);
  const multi = raw.multiSelect === true;
  const answer = parse<QuestionAnswer>(result);
  const [selected, toggle] = useSelection(multi);
  const [text, setText] = useState("");
  const canSubmit = selected.length > 0 || text.trim().length > 0;
  const submit = () => onAnswer(JSON.stringify({ selected, ...(text.trim() && { text: text.trim() }) }));

  return (
    <div className={`card ${answer ? "answered" : ""}`}>
      <div className="card-kind">Question</div>
      <div className="card-question">
        <Markdown text={String(raw.question ?? "")} />
      </div>
      {typeof raw.details === "string" && raw.details && (
        <div className="card-details">
          <Markdown text={raw.details} />
        </div>
      )}
      {options.length > 0 && (
        <div className="options">
          {options.map((o) => (
            <OptionRow
              key={o.value}
              option={o}
              multi={multi}
              checked={answer ? answer.selected.includes(o.value) : selected.includes(o.value)}
              disabled={!!answer}
              onToggle={() => toggle(o.value)}
            />
          ))}
        </div>
      )}
      {answer ? (
        answer.text && <div className="card-note">{answer.text}</div>
      ) : (
        <>
          <textarea
            className="card-input"
            rows={options.length ? 1 : 3}
            placeholder={options.length ? "Or type your own answer" : "Type your answer"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && canSubmit) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="card-actions">
            <button className="btn primary" disabled={!canSubmit} onClick={submit}>
              Submit
            </button>
          </div>
        </>
      )}
    </div>
  );
}
