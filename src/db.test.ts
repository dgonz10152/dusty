import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { addQuizHint, getMessages } from "./db.ts";
import { gradeQuiz, parseQuizArgs } from "./quiz.ts";

test("quiz hints survive reloading messages and are included in the grade", async () => {
  globalThis.window = {} as Window & typeof globalThis;
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE messages (id INTEGER, session_id TEXT, role TEXT, content TEXT, thinking TEXT, tool_calls TEXT, tool_name TEXT)");
  const args = { question: "Closest planet?", options: ["Mercury", "Venus"], correctAnswer: "Mercury" };
  sql.prepare("INSERT INTO messages VALUES (1, 'lesson', 'assistant', '', NULL, ?, NULL)").run(JSON.stringify([
    { function: { name: "ask_user_question", arguments: {} } },
    { function: { name: "quiz", arguments: args } },
  ]));
  mockIPC((cmd, payload) => {
    if (cmd === "plugin:sql|load") return "sqlite:test.db";
    const { query, values } = payload as { query: string; values: string[] };
    const statement = sql.prepare(query);
    statement.setAllowBareNamedParameters(true);
    const bindings = Object.fromEntries(values.map((v, i) => [`$${i + 1}`, v]));
    if (cmd === "plugin:sql|execute") return [Number(statement.run(bindings).changes), 0];
    if (cmd === "plugin:sql|select") return statement.all(bindings);
    throw new Error(cmd);
  });
  try {
    const hints = [
      { question: "What should I consider?", answer: "Think about orbits." },
      { question: "What else?", answer: "Compare their distance." },
    ];
    await Promise.all(hints.map((hint) => addQuizHint(1, 1, hint)));
    const call = (await getMessages("lesson"))[0].tool_calls![1];
    assert.deepEqual(call.hints, hints);
    assert.deepEqual(gradeQuiz(parseQuizArgs(call.function.arguments), ["Mercury"], "", call.hints).hints, hints);
    assert.equal((await getMessages("lesson"))[0].tool_calls![0].hints, undefined);
  } finally {
    clearMocks();
    sql.close();
    delete globalThis.window;
  }
});
