import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRef, ToolCall } from "./llm";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import Sidebar from "./components/Sidebar";
import { UpdateProgress, useUpdates } from "./components/Updates";
import { addUserMessage, pendingQuiz, runAgent, runGuidance, type Live } from "./agent";
import { DEFAULT_MODEL, getProvider, listAllModels, readModel } from "./providers";
import type { DepNode } from "./graph";
import type { Material } from "./material";
import {
  addMaterial,
  addQuizHint,
  addMessage,
  createSession,
  deleteSession,
  getAttachments,
  getMessages,
  listFolders,
  listSessions,
  setDone,
  setSetting,
  updateQuizHint,
  type Attachment,
  type ChatMessage,
  type Folder,
  type Session,
} from "./db";
import "./App.css";

type Run = { controller: AbortController; live: Live | null };

const SIDEBAR_KEY = "dusty.sidebarHidden";

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "1";
  } catch {
    return true;
  }
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("Codex:")) return msg;
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[]>([]);
  const [model, setModel] = useState<ModelRef>(DEFAULT_MODEL);
  const [setupHint, setSetupHint] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const update = useUpdates();
  const [dismissedUpdate, setDismissedUpdate] = useState("");
  const [dirtySources, setDirtySources] = useState<Set<string>>(new Set());
  const dirtyChanged = useCallback((source: string, dirty: boolean) => {
    setDirtySources((previous) => {
      if (previous.has(source) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);
  const updateBlocked = Object.keys(runs).length > 0 || dirtySources.size > 0;
  const updating = update.state.phase === "downloading" || update.state.phase === "installing";
  const activeRef = useRef(activeId);
  const controllers = useRef(new Map<string, AbortController>());

  const refreshSessions = useCallback(async () => {
    const [s, f] = await Promise.all([listSessions(), listFolders()]);
    setSessions(s);
    setFolders(f);
  }, []);
  const reloadMessages = useCallback(async (sid: string) => {
    const [m, a] = await Promise.all([getMessages(sid), getAttachments(sid)]);
    if (activeRef.current !== sid) return;
    setMessages(m);
    setAttachments(a);
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
    setAttachments([]);
    setMessages([]);
    if (sid) reloadMessages(sid);
    else setMessages([]);
  }

  function setError(sid: string, error?: string) {
    setErrors(({ [sid]: _, ...rest }) => (error ? { ...rest, [sid]: error } : rest));
  }

  function liveFor(sid: string, live: Live | null) {
    setRuns((r) => (r[sid] ? { ...r, [sid]: { ...r[sid], live } } : r));
  }

  function launch(sid: string, task: (signal: AbortSignal) => Promise<void>) {
    if (controllers.current.has(sid)) return;
    const controller = new AbortController();
    controllers.current.set(sid, controller);
    setRuns((r) => ({ ...r, [sid]: { controller, live: null } }));
    setError(sid);
    void Promise.resolve().then(() => task(controller.signal))
      .catch((e) => controller.signal.aborted || setError(sid, friendlyError(e)))
      .finally(async () => {
        await reloadMessages(sid);
        controllers.current.delete(sid);
        setRuns(({ [sid]: _, ...rest }) => rest);
        refreshSessions();
      });
  }

  async function teach(sid: string, signal: AbortSignal) {
    await runAgent(sid, signal, (live) => liveFor(sid, live), async () => {
      await reloadMessages(sid);
      refreshSessions();
    });
  }

  async function guide(sid: string, signal: AbortSignal, question?: string) {
    const target = pendingQuiz(await getMessages(sid));
    if (!target) return;
    const { messageId, callIndex, call } = target;
    let hintIndex = (call.hints?.length ?? 0) - 1;
    if (question) {
      hintIndex++;
      await addQuizHint(messageId, callIndex, { question, answer: "", status: "pending" });
    } else {
      const hint = call.hints?.[hintIndex];
      if (!hint?.status) return;
      await updateQuizHint(messageId, callIndex, hintIndex, { question: hint.question, answer: "", status: "pending" });
    }
    await reloadMessages(sid);
    await runGuidance(sid, messageId, callIndex, hintIndex, signal, (live) => liveFor(sid, live));
  }

  function start(sid: string) {
    launch(sid, async (signal) => {
      if (pendingQuiz(await getMessages(sid))) await guide(sid, signal);
      else await teach(sid, signal);
    });
  }

  async function send(text: string, material: Material[]) {
    let sid = activeId;
    if (!sid) {
      const title = text || material[0].name;
      sid = (await createSession(title.length > 60 ? `${title.slice(0, 57)}...` : title, { kind: draftKind })).id;
      select(sid, draftKind);
      if (draftKind === "exam") text ||= "Here's what my exam covers.";
    }
    const id = sid;
    launch(id, async (signal) => {
      if (pendingQuiz(await getMessages(id))) {
        await guide(id, signal, text);
        return;
      }
      const messageId = await addUserMessage(id, text || "Here are my files.");
      for (const m of material) await addMaterial(id, messageId, m);
      await reloadMessages(id);
      await teach(id, signal);
    });
  }

  function answer(call: ToolCall, content: string) {
    const sid = activeId!;
    launch(sid, async (signal) => {
      const current = pendingQuiz(await getMessages(sid));
      if (call.function.name === "quiz" && !current) return;
      if (current) {
        // Grade from persisted help, including interrupted replies, rather than a stale card render.
        const result = JSON.parse(content);
        if (current.call.hints?.length) {
          result.hints = current.call.hints;
          result.assisted = true;
        }
        content = JSON.stringify(result);
      }
      await addMessage(sid, { role: "tool", tool_name: call.function.name, content });
      await reloadMessages(sid);
      await teach(sid, signal);
    });
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

  function showSidebar(open: boolean) {
    setSidebarOpen(open);
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? "0" : "1");
    } catch {
      // Remembering it is a convenience; losing it is fine.
    }
  }

  const run = activeId ? runs[activeId] : undefined;
  const session = sessions.find((s) => s.id === activeId);

  return (
    <>
    <div className="app" inert={updating}>
      {update.state.version && !update.state.chosen && dismissedUpdate !== update.state.version && !settingsOpen && (
        <div className="update-notice" role="status">
          <span>Dusty {update.state.version} is available</span>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>View update</button>
          <button className="btn ghost" aria-label="Dismiss update notice" onClick={() => setDismissedUpdate(update.state.version!)}>Later</button>
        </div>
      )}
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
        open={sidebarOpen}
        onClose={() => showSidebar(false)}
      />
      <Chat
        key={activeId ?? `new-${draftKind}`}
        session={session}
        draftKind={draftKind}
        exam={sessions.find((s) => s.id === session?.parent_id)}
        lessons={sessions.filter((s) => s.parent_id === activeId)}
        attachments={attachments}
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
        onShowSidebar={sidebarOpen ? undefined : () => showSidebar(true)}
        onStop={() => run?.controller.abort()}
        onAnswer={answer}
        onDirtyChange={dirtyChanged}
        locked={updating}
        onRetry={() => activeId && start(activeId)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && (
        <Settings
          update={{ ...update, blocked: updateBlocked }}
          onDirtyChange={(dirty) => dirtyChanged("settings", dirty)}
          onClose={(saved) => {
            dirtyChanged("settings", false);
            setSettingsOpen(false);
            if (saved) loadConfig();
          }}
        />
      )}
    </div>
    {updating && <div className="modal-backdrop update-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Updating Dusty" tabIndex={-1} ref={(el) => el?.focus()}>
        <div className="modal-body"><UpdateProgress state={update.state} /><p className="muted">Dusty will restart when the update is installed.</p></div>
      </div>
    </div>}
    </>
  );
}
