import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SquarePen, Settings as SettingsIcon, Trash2 } from "lucide-react";
import type { ToolCall } from "ollama/browser";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import { DEFAULT_MODEL, addUserMessage, listModels, runAgent, type Live } from "./agent";
import {
  addMessage,
  createSession,
  deleteSession,
  getMessages,
  getSetting,
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
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [hasKey, setHasKey] = useState(true);
  const activeRef = useRef(activeId);

  const refreshSessions = useCallback(() => listSessions().then(setSessions), []);
  const reloadMessages = useCallback(async (sid: string) => {
    const m = await getMessages(sid);
    if (activeRef.current === sid) setMessages(m);
  }, []);
  const loadConfig = useCallback(async () => {
    setModel(await getSetting("model", DEFAULT_MODEL));
    setHasKey(!!(await invoke<string | null>("get_api_key")));
    listModels().then(setModels, () => setModels([]));
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
        hasKey={hasKey}
        models={models}
        model={model}
        onModelChange={(m) => {
          setModel(m);
          setSetting("model", m);
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
