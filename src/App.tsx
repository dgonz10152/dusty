import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRef, ToolCall } from "./llm";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import Sidebar from "./components/Sidebar";
import { addUserMessage, runAgent, type Live } from "./agent";
import { DEFAULT_MODEL, getProvider, listAllModels, readModel } from "./providers";
import {
  addMessage,
  createSession,
  deleteSession,
  getMessages,
  listFolders,
  listSessions,
  setSetting,
  type ChatMessage,
  type Folder,
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

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[]>([]);
  const [model, setModel] = useState<ModelRef>(DEFAULT_MODEL);
  const [setupHint, setSetupHint] = useState<string | null>(null);
  const activeRef = useRef(activeId);

  const refreshSessions = useCallback(async () => {
    const [s, f] = await Promise.all([listSessions(), listFolders()]);
    setSessions(s);
    setFolders(f);
  }, []);
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
      <Sidebar
        sessions={sessions}
        folders={folders}
        activeId={activeId}
        running={(sid) => !!runs[sid]}
        onSelect={select}
        onDelete={remove}
        onChange={refreshSessions}
        onOpenSettings={() => setSettingsOpen(true)}
      />
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
