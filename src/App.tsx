import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRef, ToolCall } from "./llm";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import Sidebar from "./components/Sidebar";
import { addUserMessage, runAgent, type Live } from "./agent";
import { DEFAULT_MODEL, getProvider, listAllModels, readModel } from "./providers";
import type { DepNode } from "./graph";
import type { Material } from "./material";
import {
  addMaterial,
  addMessage,
  createSession,
  deleteSession,
  getMaterialNames,
  getMessages,
  listFolders,
  listSessions,
  setDone,
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
  // What "send" creates while no session is open.
  const [draftKind, setDraftKind] = useState<Session["kind"]>("lesson");
  const [materialNames, setMaterialNames] = useState<string[]>([]);
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

  function select(sid: string | null, kind: Session["kind"] = "lesson") {
    activeRef.current = sid;
    setActiveId(sid);
    setDraftKind(kind);
    setMaterialNames([]);
    if (sid) {
      reloadMessages(sid);
      getMaterialNames(sid).then((names) => activeRef.current === sid && setMaterialNames(names));
    } else setMessages([]);
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

  async function send(text: string, material: Material[] = []) {
    let sid = activeId;
    if (!sid) {
      // ponytail: title is the first message; ask the model for a title if these read badly
      const title = text || material[0]?.name || "Exam";
      sid = (await createSession(title.length > 60 ? `${title.slice(0, 57)}...` : title, { kind: draftKind })).id;
      for (const m of material) await addMaterial(sid, m);
      select(sid, draftKind);
      text ||= "Here's what my exam covers.";
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

  /** Opens the exam lesson for a map node, creating and starting it the first time. */
  async function study(exam: Session, node: DepNode) {
    let child = sessions.find((s) => s.parent_id === exam.id && s.node_id === node.id);
    child ??= await createSession(node.label, { parent_id: exam.id, node_id: node.id });
    select(child.id);
    // A lesson marked done before it was ever opened has no messages yet.
    if ((await getMessages(child.id)).length === 0) {
      await addUserMessage(child.id, `Teach me ${node.label} for ${exam.title}.`);
      await reloadMessages(child.id);
      start(child.id);
    }
    refreshSessions();
  }

  async function toggleDone(exam: Session, node: DepNode) {
    const child = sessions.find((s) => s.parent_id === exam.id && s.node_id === node.id);
    if (child) await setDone(child.id, !child.done);
    else await setDone((await createSession(node.label, { parent_id: exam.id, node_id: node.id })).id, true);
    refreshSessions();
  }

  async function remove(sid: string) {
    runs[sid]?.controller.abort();
    await deleteSession(sid);
    if (activeId === sid) select(null);
    refreshSessions();
  }

  const run = activeId ? runs[activeId] : undefined;
  const session = sessions.find((s) => s.id === activeId);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        folders={folders}
        activeId={activeId}
        running={(sid) => !!runs[sid]}
        onSelect={select}
        onNew={(kind) => select(null, kind)}
        onDelete={remove}
        onChange={refreshSessions}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Chat
        key={activeId ?? `new-${draftKind}`}
        session={session}
        draftKind={draftKind}
        exam={sessions.find((s) => s.id === session?.parent_id)}
        lessons={sessions.filter((s) => s.parent_id === activeId)}
        materialNames={materialNames}
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
        onStudy={(node) => session && study(session, node)}
        onToggleDone={(node) => session && toggleDone(session, node)}
        onOpen={select}
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
