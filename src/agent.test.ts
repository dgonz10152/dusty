import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { ChatRequest } from "./llm.ts";

// Match Vite's extensionless local imports while testing the real agent in Node.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    for (const suffix of [".ts", "/index.ts"]) {
      try { return next(specifier + suffix, context); } catch { /* Try the directory entry point. */ }
    }
  }
  return next(specifier, context);
} });

const { runGuidance, runAgent, pendingCall } = await import("./agent.ts");
const { addQuizHint, addMessage, getMessages, getSession } = await import("./db.ts");
const { getProvider } = await import("./providers/index.ts");
const { gradeQuiz, parseQuizArgs } = await import("./quiz.ts");
const args = { question: "2 + 2?", options: ["4", "5"], correctAnswer: "4", explanation: "Addition" };

async function fixture(work: (sql: DatabaseSync) => Promise<void>) {
  globalThis.window = {} as Window & typeof globalThis;
  const sql = new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE sessions (id TEXT, title TEXT, parent_id TEXT, node_id TEXT, kind TEXT, done INTEGER DEFAULT 0, updated_at INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, thinking TEXT, tool_calls TEXT, tool_name TEXT, created_at INTEGER);
    CREATE TABLE materials (id INTEGER PRIMARY KEY, session_id TEXT, message_id INTEGER, name TEXT, content TEXT);
    CREATE TABLE settings (key TEXT, value TEXT);
    INSERT INTO sessions (id, title, kind) VALUES ('lesson', 'Addition', 'lesson'), ('other', 'Other lesson', 'lesson');
    INSERT INTO materials VALUES (1, 'lesson', 1, 'Course notes', 'Use the number line.');
  `);
  sql.prepare("INSERT INTO messages (id, session_id, role, content, tool_calls) VALUES (1, 'lesson', 'assistant', 'Here is our check.', ?)")
    .run(JSON.stringify([{ function: { name: "quiz", arguments: args } }]));
  mockIPC((cmd, payload) => {
    if (cmd === "plugin:sql|load") return "sqlite:test.db";
    const { query, values = [] } = payload as { query: string; values: unknown[] };
    const statement = sql.prepare(query);
    statement.setAllowBareNamedParameters(true);
    const bindings = Object.fromEntries(values.map((v, i) => [`$${i + 1}`, v]));
    if (cmd === "plugin:sql|execute") {
      const result = statement.run(bindings);
      return [Number(result.changes), Number(result.lastInsertRowid)];
    }
    if (cmd === "plugin:sql|select") return statement.all(bindings);
    throw new Error(cmd);
  });
  const provider = getProvider("ollama");
  const chat = provider.chat;
  try { await work(sql); }
  finally { provider.chat = chat; clearMocks(); sql.close(); delete globalThis.window; }
}

test("streaming quiz discussion stays on its original quiz, persists, and reaches the eventual grade", async () => fixture(async () => {
  await addQuizHint(1, 0, { question: "How do I begin?", answer: "", status: "pending" });
  let streamed = "";
  getProvider("ollama").chat = async (req: ChatRequest) => {
    assert.deepEqual(req.tools, []);
    assert.ok(req.messages.every((m) => !m.tool_calls && m.role !== "tool"));
    assert.match(req.messages.map((m) => m.content).join("\n"), /Use the number line/);
    assert.match(req.system, /Current mode: quiz discussion/);
    // Opening a different lesson does not affect the running request's database target.
    await getMessages("other");
    req.onDelta?.({ role: "assistant", content: "Try small steps." });
    return { role: "assistant", content: "Try small steps." };
  };
  await runGuidance("lesson", 1, 0, 0, new AbortController().signal, (live) => { if (live) streamed = live.content; });
  const messages = await getMessages("lesson");
  const call = pendingCall(messages)!;
  assert.equal(streamed, "Try small steps.");
  assert.equal(messages.length, 1);
  assert.equal(call.hints![0].answer, streamed);
  assert.equal(call.hints![0].status, undefined);
  assert.equal((await getMessages("other")).length, 0);
  await addMessage("lesson", { role: "tool", tool_name: "quiz", content: JSON.stringify(gradeQuiz(parseQuizArgs(args), ["4"], "", call.hints)) });
  assert.equal(pendingCall(await getMessages("lesson")), undefined);
  assert.equal(JSON.parse((await getMessages("lesson"))[1].content).assisted, true);
}));

test("stopped and failed guidance retain their question and partial help and can be retried", async () => fixture(async () => {
  await addQuizHint(1, 0, { question: "Can you clarify?", answer: "", status: "pending" });
  for (const stop of [true, false]) {
    const controller = new AbortController();
    getProvider("ollama").chat = async (req) => {
      req.onDelta?.({ role: "assistant", content: "Think of a number line." });
      if (stop) controller.abort();
      throw new Error("connection lost");
    };
    await assert.rejects(runGuidance("lesson", 1, 0, 0, controller.signal, () => {}));
    const hint = pendingCall(await getMessages("lesson"))!.hints![0];
    assert.equal(hint.status, stop ? "stopped" : "failed");
    assert.equal(hint.answer, "Think of a number line.");
  }
  getProvider("ollama").chat = async () => ({ role: "assistant", content: "Start at the first number and take steps." });
  await runGuidance("lesson", 1, 0, 0, new AbortController().signal, () => {});
  const hints = pendingCall(await getMessages("lesson"))!.hints!;
  assert.equal(hints.length, 1);
  assert.equal(hints[0].status, undefined);
}));

test("automatic lesson completion rejects an assisted check and accepts a later independent one", async () => fixture(async (sql) => {
  await addMessage("lesson", { role: "tool", tool_name: "quiz", content: JSON.stringify({ result: "correct", assisted: true }) });
  await addMessage("lesson", { role: "assistant", content: "", tool_calls: [{ function: { name: "complete_lesson", arguments: {} } }] });
  let reply = 0;
  getProvider("ollama").chat = async () => {
    reply++;
    return reply === 1 ? { role: "assistant", content: "Try a fresh check.", tool_calls: [{ function: { name: "quiz", arguments: { ...args, question: "3 + 3?", correctAnswer: "6", options: ["6", "7"] } } }] }
      : { role: "assistant", content: "All done." };
  };
  await runAgent("lesson", new AbortController().signal, () => {}, async () => {});
  assert.equal((await getSession("lesson"))!.done, 0);
  assert.match((await getMessages("lesson"))[3].content, /Not completed/);
  await addMessage("lesson", { role: "tool", tool_name: "quiz", content: JSON.stringify({ result: "correct", selected: ["6"], correctAnswer: ["6"] }) });
  await addMessage("lesson", { role: "assistant", content: "", tool_calls: [{ function: { name: "complete_lesson", arguments: {} } }] });
  await runAgent("lesson", new AbortController().signal, () => {}, async () => {});
  assert.equal((await getSession("lesson"))!.done, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM messages WHERE tool_name = 'quiz'").get()!.n, 2);
}));
