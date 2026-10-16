import { useCallback, useEffect, useRef, useState } from "react";
import { SquarePen, Settings as SettingsIcon, Trash2 } from "lucide-react";
import type { ModelRef, ToolCall } from "./llm";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import { addUserMessage, runAgent, type Live } from "./agent";
import { DEFAULT_MODEL, getProvider, listAllModels, readModel } from "./providers";
import {
  addMessage,
  createSession,
  deleteSession,
  getMessages,
  listSessions,
  setSetting,
  type ChatMessage,
  type Session,
} from "./db";
import "./App.css";

type Run = { controller: AbortController; live: Live | null };

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized/i.test(msg)) return "Ollama rejected the API key. Check it in Settings.";
  if (/does not support tools/i.test(msg)) return "This model can't use tools (quizzes, research). Pick another model.";
  if (/Claude Code isn't installed/.test(msg)) return "Claude Code isn't installed. Get it at claude.com/claude-code, then restart Dusty.";
  if (/not logged in|run \/login/i.test(msg)) return "Claude Code isn't logged in. Run claude once in a terminal to sign in.";
  return msg;
}

function relativeTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[]>([]);
  const [model, setModel] = useState<ModelRef>(DEFAULT_MODEL);
  const [setupHint, setSetupHint] = useState<string | null>(null);
  const activeRef = useRef(activeId);

  const refreshSessions = useCallback(() => listSessions().then(setSessions), []);
  const reloadMessages = useCallback(async (sid: string) => {
    const m = await getMessages(sid);
    if (activeRef.current === sid) setMessages(m);
  }, []);
  const loadConfig = useCallback(async () => {
    const m = await readModel();
    setModel(m);
    getProvider(m.provider).setupHint().then(setSetupHint, () => setSetupHint(null));
    listAllModels().then(setModels);
  }, []);

  useEffect(() => {
    refreshSessions();
    loadConfig();
  }, [refreshSessions, loadConfig]);

  function select(sid: string | null) {
    activeRef.current = sid;
    setActiveId(sid);
    if (sid) reloadMessages(sid);
    else setMessages([]);
  }

  function setError(sid: string, error?: string) {
    setErrors(({ [sid]: _, ...rest }) => (error ? { ...rest, [sid]: error } : rest));
  }

  function start(sid: string) {
    const controller = new AbortController();
    setRuns((r) => ({ ...r, [sid]: { controller, live: null } }));
    setError(sid);
    runAgent(
      sid,
      controller.signal,
      (live) => setRuns((r) => (r[sid] ? { ...r, [sid]: { ...r[sid], live } } : r)),
      async () => {
        await reloadMessages(sid);
        refreshSessions();
      },
    )
      .catch((e) => controller.signal.aborted || setError(sid, friendlyError(e)))
      .finally(() => {
        setRuns(({ [sid]: _, ...rest }) => rest);
        reloadMessages(sid);
      });
  }

  async function send(text: string) {
    let sid = activeId;
    if (!sid) {
      // ponytail: title is the first message; ask the model for a title if these read badly
      sid = (await createSession(text.length > 60 ? `${text.slice(0, 57)}...` : text)).id;
      select(sid);
    }
    await addUserMessage(sid, text);
    await reloadMessages(sid);
    refreshSessions();
    start(sid);
  }

  async function answer(call: ToolCall, content: string) {
    const sid = activeId!;
    await addMessage(sid, { role: "tool", tool_name: call.function.name, content });
    await reloadMessages(sid);
    start(sid);
  }

  async function remove(sid: string) {
    runs[sid]?.controller.abort();
    await deleteSession(sid);
    if (activeId === sid) select(null);
    refreshSessions();
  }

  const run = activeId ? runs[activeId] : undefined;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top" data-tauri-drag-region />
        <button className="nav-item" onClick={() => select(null)}>
          <SquarePen size={16} /> New lesson
        </button>
        {sessions.length > 0 && <div className="sidebar-label">Lessons</div>}
        <nav className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              className={`session ${s.id === activeId ? "active" : ""}`}
              onClick={() => select(s.id)}
              onKeyDown={(e) => e.key === "Enter" && select(s.id)}
            >
              <span className="session-title">{s.title}</span>
              {runs[s.id] ? <span className="dot-pulse small" /> : <span className="session-time">{relativeTime(s.updated_at)}</span>}
              <button
                className="icon-btn session-delete"
                aria-label="Delete lesson"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s.id);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </nav>
        <button className="nav-item" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={16} /> Settings
        </button>
      </aside>
      <Chat
        key={activeId ?? "new"}
        title={sessions.find((s) => s.id === activeId)?.title}
        messages={messages}
        live={run?.live ?? null}
        running={!!run}
        error={activeId ? errors[activeId] : undefined}
        setupHint={setupHint}
        models={models}
        model={model}
        onModelChange={async (m) => {
          setModel(m);
          await setSetting("model", m);
          loadConfig();
        }}
        onSend={send}
        onStop={() => run?.controller.abort()}
        onAnswer={answer}
        onRetry={() => activeId && start(activeId)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <Settings
          onClose={(saved) => {
            setSettingsOpen(false);
            if (saved) loadConfig();
          }}
        />
      )}
    </div>
  );
}
