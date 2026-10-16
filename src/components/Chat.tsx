import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Globe, Square } from "lucide-react";
import type { ModelRef, ToolCall } from "../llm";
import Markdown from "./Markdown";
import { QuestionCard, QuizCard } from "./Cards";
import { INTERACTIVE, pendingCall, type Live } from "../agent";
import { PROVIDERS, sameModel } from "../providers";
import type { ChatMessage } from "../db";

type Props = {
  title?: string;
  messages: ChatMessage[];
  live: Live | null;
  running: boolean;
  error?: string;
  setupHint: string | null;
  models: ModelRef[];
  model: ModelRef;
  onModelChange: (model: ModelRef) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onAnswer: (call: ToolCall, content: string) => void;
  onRetry: () => void;
  onOpenSettings: () => void;
};

function Thinking({ text, active }: { text: string; active?: boolean }) {
  return (
    <details className="thinking">
      <summary className={active ? "shimmer" : ""}>{active ? "Thinking" : "Thought"}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

const WRITING: Record<string, string> = {
  quiz: "Writing a quiz",
  ask_user_question: "Writing a question",
  research: "Planning research",
};

function ToolView({ call, result, onAnswer }: { call: ToolCall; result?: string; onAnswer?: (content: string) => void }) {
  const args = call.function.arguments;
  if (result?.startsWith("Cancelled")) {
    return <div className="tool-chip muted">Skipped: {String(args.question ?? call.function.name)}</div>;
  }
  const answer = onAnswer ?? (() => {});
  if (call.function.name === "quiz") return <QuizCard args={args} result={result} onAnswer={answer} />;
  if (call.function.name === "ask_user_question") return <QuestionCard args={args} result={result} onAnswer={answer} />;
  if (call.function.name === "research") {
    return (
      <details className="tool-chip">
        <summary>
          <Globe size={14} /> Researched: {String(args.question ?? "")}
        </summary>
        {result && <Markdown text={result} />}
      </details>
    );
  }
  return null;
}

function Composer({
  disabled,
  running,
  placeholder,
  models,
  model,
  onModelChange,
  onSend,
  onStop,
  autoFocus,
}: Pick<Props, "running" | "models" | "model" | "onModelChange" | "onSend" | "onStop"> & {
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const canSend = !disabled && !running && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };
  const options = models.some((m) => sameModel(m, model)) ? models : [model, ...models];
  const label = (m: ModelRef) => `${PROVIDERS.find((p) => p.id === m.provider)?.label ?? m.provider} · ${m.model}`;

  return (
    <div className={`composer ${disabled ? "disabled" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        <label className="model-picker">
          <select
            value={options.findIndex((m) => sameModel(m, model))}
            onChange={(e) => onModelChange(options[Number(e.target.value)])}
            aria-label="Model"
          >
            {PROVIDERS.filter((p) => options.some((m) => m.provider === p.id)).map((p) => (
              <optgroup key={p.id} label={p.label}>
                {options.map((m, i) =>
                  m.provider === p.id ? (
                    <option key={i} value={i}>
                      {m.model}
                    </option>
                  ) : null,
                )}
              </optgroup>
            ))}
          </select>
          <span>{label(model)}</span>
          <ChevronDown size={14} />
        </label>
        {running ? (
          <button className="send-btn" aria-label="Stop" onClick={onStop}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button className="send-btn" aria-label="Send" disabled={!canSend} onClick={send}>
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export default function Chat(props: Props) {
  const { title, messages, live, running, error, setupHint, onAnswer, onRetry, onOpenSettings } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  const pending = pendingCall(messages);
  const waitingOnStudent = !running && !!pending && INTERACTIVE.has(pending.function.name);
  const composer = (
    <Composer
      {...props}
      autoFocus
      disabled={waitingOnStudent}
      placeholder={waitingOnStudent ? "Answer the question above to continue" : messages.length ? "Reply to Dusty" : "Ask Dusty to teach you anything"}
      onSend={(text) => {
        stick.current = true;
        props.onSend(text);
      }}
    />
  );

  const items = messages.map((m, i) => {
    if (m.role === "user") {
      return (
        <div key={m.id} className="msg user">
          <div className="bubble">{m.content}</div>
        </div>
      );
    }
    if (m.role !== "assistant") return null;
    const results: ChatMessage[] = [];
    for (let j = i + 1; messages[j]?.role === "tool"; j++) results.push(messages[j]);
    return (
      <div key={m.id} className="msg assistant">
        {m.thinking && <Thinking text={m.thinking} />}
        {m.content && <Markdown text={m.content} />}
        {m.tool_calls?.map((call, k) => (
          <ToolView
            key={k}
            call={call}
            result={results[k]?.content}
            onAnswer={waitingOnStudent && call === pending ? (content) => onAnswer(call, content) : undefined}
          />
        ))}
      </div>
    );
  });

  return (
    <main className="main">
      <header className="main-header" data-tauri-drag-region>
        <span className="main-title" data-tauri-drag-region>
          {title}
        </span>
      </header>
      {messages.length === 0 ? (
        <div className="empty">
          <h1>What do you want to learn?</h1>
          <p className="muted">Dusty finds what you already know, plans a path, then teaches it so it sticks.</p>
          {setupHint && (
            <button className="notice" onClick={onOpenSettings}>
              {setupHint}
            </button>
          )}
          <div className="empty-composer">{composer}</div>
        </div>
      ) : (
        <>
          <div
            className="scroller"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="thread">
              {items}
              {live?.status && (
                <div className="msg assistant">
                  <div className="tool-chip shimmer">
                    <Globe size={14} /> {live.status}
                  </div>
                </div>
              )}
              {live && !live.status && (
                <div className="msg assistant">
                  {live.thinking && <Thinking text={live.thinking} active={!live.content} />}
                  {live.content && <Markdown text={live.content} streaming />}
                  {live.tool && <div className="tool-chip shimmer">{WRITING[live.tool] ?? `Calling ${live.tool}`}</div>}
                </div>
              )}
              {running && !live && <div className="msg assistant"><span className="dot-pulse" /></div>}
              {error && (
                <div className="error-banner">
                  <span>{error}</span>
                  <button className="btn ghost" onClick={onRetry}>
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="composer-dock">{composer}</div>
        </>
      )}
    </main>
  );
}
