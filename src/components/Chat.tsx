import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileText,
  Globe,
  GraduationCap,
  ImageIcon,
  PanelLeftOpen,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import type { Hint } from "../quiz";
import type { ModelRef, ToolCall } from "../llm";
import Markdown, { ExamMapContext, InlineMath, type ExamMap } from "./Markdown";
import { QuestionCard, QuizCard } from "./Cards";
import { INTERACTIVE, pendingCall, transcribeImage, type Live } from "../agent";
import { PROVIDERS, sameModel } from "../providers";
import type { Attachment, ChatMessage, Session } from "../db";
import { latestMap, type DepNode } from "../graph";
import { extractText, isImage, materialError, type Material } from "../material";

type Props = {
  session?: Session;
  /** What sending creates when no session is open yet. */
  draftKind: Session["kind"];
  /** The exam this lesson belongs to, if any. */
  exam?: Session;
  /** An exam's lessons. */
  lessons: Session[];
  attachments: Attachment[];
  messages: ChatMessage[];
  live: Live | null;
  running: boolean;
  error?: string;
  setupHint: string | null;
  models: ModelRef[];
  model: ModelRef;
  onModelChange: (model: ModelRef) => void;
  onSend: (text: string, material: Material[]) => void;
  onStop: () => void;
  onAnswer: (call: ToolCall, content: string) => void;
  onHint: (messageId: number, callIndex: number, hint: Hint) => Promise<void>;
  onRetry: () => void;
  onOpenSettings: () => void;
  onStudy: (node: DepNode) => void;
  onToggleDone: (node: DepNode) => void;
  onOpen: (sid: string) => void;
  /** Set while the sidebar is hidden. */
  onShowSidebar?: () => void;
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
  complete_lesson: "Marking the lesson done",
  save_course: "Saving your course",
};

function ToolView({
  call,
  result,
  onAnswer,
  probing,
  onHint,
}: {
  call: ToolCall;
  onHint: (hint: Hint) => Promise<void>;
  result?: string;
  onAnswer?: (content: string) => void;
  /** Still finding the student's level: no plan yet. */
  probing?: boolean;
}) {
  const args = call.function.arguments;
  if (result?.startsWith("Cancelled")) {
    return <div className="tool-chip muted">Skipped: {String(args.question ?? call.function.name)}</div>;
  }
  const answer = onAnswer ?? (() => {});
  if (call.function.name === "quiz") return <QuizCard args={args} result={result} onAnswer={answer} fromBasics={probing && !!onAnswer} hints={call.hints} onHint={onHint} />;
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
  if (call.function.name === "save_course") {
    return (
      <div className="tool-chip">
        <BookmarkPlus size={14} /> Saved {String(args.course ?? "the course")} to your courses
      </div>
    );
  }
  if (call.function.name === "complete_lesson") {
    return (
      <div className="tool-chip">
        <CircleCheck size={14} /> Marked done on the exam map
      </div>
    );
  }
  return null;
}

/** A file in the composer, before it's sent. */
type Staged = { id: string; name: string; content?: string; error?: string };

const DOCUMENT = /\.(pdf|txt|md|markdown)$/i;
// Pastes longer than this become an attachment instead of filling the message box.
const LONG_PASTE = 2000;

function AttachmentChip({ name, loading, error, onRemove }: { name: string; loading?: boolean; error?: string; onRemove?: () => void }) {
  return (
    <div className={`attachment ${error ? "failed" : ""}`} title={error ?? name}>
      {loading ? <span className="dot-pulse small" /> : isImage(name) ? <ImageIcon size={14} /> : <FileText size={14} />}
      <span className="attachment-name">{name}</span>
      {error && <span className="attachment-error">{error}</span>}
      {onRemove && (
        <button className="icon-btn" aria-label={`Remove ${name}`} onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </div>
  );
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
  attachments,
  onAttach,
  onLongPaste,
  canSendEmpty,
  blocked,
}: Pick<Props, "running" | "models" | "model" | "onModelChange" | "onStop"> & {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean;
  attachments?: ReactNode;
  onAttach?: () => void;
  onLongPaste?: (text: string) => void;
  /** Sendable without text, because something is attached. */
  canSendEmpty?: boolean;
  /** Not sendable yet, whatever the text. */
  blocked?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const canSend = !disabled && !running && !blocked && (text.trim().length > 0 || !!canSendEmpty);
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };
  const options = models.some((m) => sameModel(m, model)) ? models : [model, ...models];
  const label = (m: ModelRef) => `${PROVIDERS.find((p) => p.id === m.provider)?.label ?? m.provider} · ${m.model}`;

  return (
    <div className={`composer ${disabled ? "disabled" : ""}`}>
      {attachments}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text/plain");
          if (onLongPaste && pasted.length > LONG_PASTE) {
            e.preventDefault();
            onLongPaste(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-tools">
          {onAttach && (
            <button
              className="icon-btn attach-btn"
              aria-label="Add files"
              title="Add PDFs, pictures, .txt, or .md files"
              disabled={disabled}
              onClick={onAttach}
            >
              <Paperclip size={16} />
            </button>
          )}
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
        </div>
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
  const { session, draftKind, exam, lessons, attachments, messages, live, running, error, setupHint, onAnswer, onRetry, onOpenSettings } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  const patch = (id: string, a: Partial<Staged>) => setStaged((list) => list.map((x) => (x.id === id ? { ...x, ...a } : x)));
  function attach(files: File[]) {
    for (const file of files) {
      const id = crypto.randomUUID();
      if (isImage(file.name)) {
        setStaged((list) => [...list, { id, name: file.name }]);
        transcribeImage(file).then(
          (content) => patch(id, { content }),
          (e) =>
            patch(id, {
              error: /can't read images/.test(String(e))
                ? "This model can't see pictures. Pick a Claude model or a vision model."
                : "Couldn't read this picture",
            }),
        );
        continue;
      }
      if (!DOCUMENT.test(file.name)) {
        setStaged((list) => [...list, { id, name: file.name, error: "Only PDFs, pictures, .txt, and .md files" }]);
        continue;
      }
      setStaged((list) => [...list, { id, name: file.name }]);
      extractText(file).then(
        (content) => patch(id, content.replace(/--- Page \d+ ---/g, "").trim() ? { content } : { error: "No text found. Is it a scanned PDF?" }),
        () => patch(id, { error: "Couldn't read this file" }),
      );
    }
  }
  function attachText(content: string) {
    setStaged((list) => {
      const n = list.filter((a) => a.name.startsWith("Pasted text")).length;
      return [...list, { id: crypto.randomUUID(), name: n ? `Pasted text ${n + 1}` : "Pasted text", content }];
    });
  }

  const material: Material[] = staged.filter((a) => a.content).map((a) => ({ name: a.name, content: a.content! }));
  const loading = staged.some((a) => a.content === undefined && !a.error);
  // ponytail: an exam lesson's check leaves out the exam's own material; the provider's context error is the backstop
  const sizeError = materialError([...attachments.map((a) => a.size), ...material.map((m) => m.content.length)].reduce((n, c) => n + c, 0));

  const examMap = useMemo<ExamMap | null>(
    () =>
      session?.kind === "exam"
        ? {
            statusOf: (id) => {
              const lesson = lessons.find((s) => s.node_id === id);
              return !lesson ? "todo" : lesson.done ? "done" : "started";
            },
            onStudy: props.onStudy,
            onToggleDone: props.onToggleDone,
          }
        : null,
    [session?.kind, lessons, props.onStudy, props.onToggleDone],
  );

  const pending = pendingCall(messages);
  const waitingOnStudent = !running && !!pending && INTERACTIVE.has(pending.function.name);
  // The plan's map ends probing.
  const probing = useMemo(() => !latestMap(messages), [messages]);
  const drafting = !session && draftKind === "exam";
  const composer = (
    <Composer
      {...props}
      autoFocus
      disabled={waitingOnStudent}
      placeholder={
        waitingOnStudent
          ? "Answer the question above to continue"
          : messages.length
            ? "Reply to Dusty"
            : drafting
              ? "Which exam is it? Add your material with the paperclip, or drop files here"
              : "Ask Dusty to teach you anything, or drop in your notes"
      }
      onSend={(text) => {
        stick.current = true;
        props.onSend(text, material);
        setStaged([]);
      }}
      attachments={
        staged.length > 0 && (
          <div className="attachments">
            {staged.map((a) => (
              <AttachmentChip
                key={a.id}
                name={a.name}
                loading={a.content === undefined && !a.error}
                error={a.error}
                onRemove={() => setStaged((list) => list.filter((x) => x.id !== a.id))}
              />
            ))}
          </div>
        )
      }
      onAttach={() => fileInput.current?.click()}
      onLongPaste={attachText}
      canSendEmpty={material.length > 0}
      blocked={loading || !!sizeError}
    />
  );
  const sizeNotice = sizeError && <div className="composer-error">{sizeError}</div>;

  const items = messages.map((m, i) => {
    if (m.role === "user") {
      const files = attachments.filter((a) => a.message_id === m.id);
      return (
        <div key={m.id} className="msg user">
          {files.length > 0 && (
            <div className="attachments sent">
              {files.map((a, k) => (
                <AttachmentChip key={k} name={a.name} />
              ))}
            </div>
          )}
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
            onHint={(hint) => props.onHint(m.id, k, hint)}
            probing={probing}
          />
        ))}
      </div>
    );
  });

  return (
    <main
      className={`main ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (waitingOnStudent || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        attach([...e.dataTransfer.files]);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept=".pdf,.txt,.md,.markdown,image/*,.heic,.heif"
        onChange={(e) => {
          attach([...(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }}
      />
      <header className={`main-header ${props.onShowSidebar ? "sidebar-hidden" : ""}`} data-tauri-drag-region>
        {props.onShowSidebar && (
          <button className="icon-btn sidebar-toggle" aria-label="Show sidebar" title="Show sidebar" onClick={props.onShowSidebar}>
            <PanelLeftOpen size={16} />
          </button>
        )}
        {exam && (
          <>
            <button className="crumb" onClick={() => props.onOpen(exam.id)}>
              <GraduationCap size={14} />
              <span>
                <InlineMath text={exam.title} />
              </span>
            </button>
            <ChevronRight size={14} className="crumb-sep" />
          </>
        )}
        <span className="main-title" data-tauri-drag-region>
          {session && <InlineMath text={session.title} />}
        </span>
      </header>
      {messages.length === 0 ? (
        <div className="empty">
          <h1>{drafting ? "What's your exam on?" : "What do you want to learn?"}</h1>
          <p className="muted">
            {drafting
              ? "Add your slides, notes, study guide, or photos of them. Dusty maps every concept on the exam, then teaches each one as its own lesson."
              : "Dusty finds what you already know, plans a path, then teaches it so it sticks."}
          </p>
          {setupHint && (
            <button className="notice" onClick={onOpenSettings}>
              {setupHint}
            </button>
          )}
          <div className="empty-composer">
            {composer}
            {sizeNotice}
          </div>
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
            <ExamMapContext value={examMap}>
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
                {running && !live && (
                  <div className="msg assistant">
                    <span className="dot-pulse" />
                  </div>
                )}
                {error && (
                  <div className="error-banner">
                    <span>{error}</span>
                    <button className="btn ghost" onClick={onRetry}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </ExamMapContext>
          </div>
          <div className="composer-dock">
            {composer}
            {sizeNotice}
          </div>
        </>
      )}
    </main>
  );
}
