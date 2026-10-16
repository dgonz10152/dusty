import Database from "@tauri-apps/plugin-sql";
import type { Message } from "./llm";
import type { Material } from "./material";

export type Session = {
  id: string;
  title: string;
  folder_id: string | null;
  kind: "lesson" | "exam";
  /** The exam a child lesson belongs to. */
  parent_id: string | null;
  /** The exam map node a child lesson covers. */
  node_id: string | null;
  done: 0 | 1;
  created_at: number;
  updated_at: number;
};
export type Folder = { id: string; name: string; created_at: number };
export type ChatMessage = Message & { id: number; role: "user" | "assistant" | "tool" };

type MessageRow = {
  id: number;
  role: ChatMessage["role"];
  content: string;
  thinking: string | null;
  tool_calls: string | null;
  tool_name: string | null;
};

let dbPromise: Promise<Database> | null = null;
function db() {
  dbPromise ??= Database.load("sqlite:dusty.db");
  return dbPromise;
}

export async function listSessions(): Promise<Session[]> {
  return (await db()).select("SELECT * FROM sessions ORDER BY updated_at DESC");
}

export async function getSession(id: string): Promise<Session | undefined> {
  const rows: Session[] = await (await db()).select("SELECT * FROM sessions WHERE id = $1", [id]);
  return rows[0];
}

export async function createSession(
  title: string,
  extra: Partial<Pick<Session, "kind" | "parent_id" | "node_id">> = {},
): Promise<Session> {
  const now = Date.now();
  const session: Session = {
    id: crypto.randomUUID(),
    title,
    folder_id: null,
    kind: extra.kind ?? "lesson",
    parent_id: extra.parent_id ?? null,
    node_id: extra.node_id ?? null,
    done: 0,
    created_at: now,
    updated_at: now,
  };
  await (await db()).execute(
    "INSERT INTO sessions (id, title, kind, parent_id, node_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [session.id, title, session.kind, session.parent_id, session.node_id, now, now],
  );
  return session;
}

/** Deleting an exam keeps its lessons, which move back to the top level. */
export async function deleteSession(id: string) {
  // ponytail: explicit delete instead of ON DELETE CASCADE, since PRAGMA foreign_keys is per pooled connection
  const d = await db();
  await d.execute("UPDATE sessions SET parent_id = NULL, node_id = NULL WHERE parent_id = $1", [id]);
  await d.execute("DELETE FROM materials WHERE session_id = $1", [id]);
  await d.execute("DELETE FROM messages WHERE session_id = $1", [id]);
  await d.execute("DELETE FROM sessions WHERE id = $1", [id]);
}

export async function renameSession(id: string, title: string) {
  await (await db()).execute("UPDATE sessions SET title = $1 WHERE id = $2", [title, id]);
}

export async function setDone(id: string, done: boolean) {
  await (await db()).execute("UPDATE sessions SET done = $1 WHERE id = $2", [done ? 1 : 0, id]);
}

export async function addMaterial(sessionId: string, m: Material) {
  await (await db()).execute("INSERT INTO materials (session_id, name, content) VALUES ($1, $2, $3)", [sessionId, m.name, m.content]);
}

export async function getMaterial(sessionId: string): Promise<Material[]> {
  return (await db()).select("SELECT name, content FROM materials WHERE session_id = $1 ORDER BY id", [sessionId]);
}

/** Just the file names, without loading the text. */
export async function getMaterialNames(sessionId: string): Promise<string[]> {
  const rows: { name: string }[] = await (await db()).select("SELECT name FROM materials WHERE session_id = $1 ORDER BY id", [sessionId]);
  return rows.map((r) => r.name);
}

export async function listFolders(): Promise<Folder[]> {
  return (await db()).select("SELECT * FROM folders ORDER BY name COLLATE NOCASE");
}

export async function createFolder(name: string): Promise<Folder> {
  const folder = { id: crypto.randomUUID(), name, created_at: Date.now() };
  await (await db()).execute("INSERT INTO folders (id, name, created_at) VALUES ($1, $2, $3)", [folder.id, name, folder.created_at]);
  return folder;
}

export async function renameFolder(id: string, name: string) {
  await (await db()).execute("UPDATE folders SET name = $1 WHERE id = $2", [name, id]);
}

/** Deletes the folder but keeps its lessons, which move back to the top level. */
export async function deleteFolder(id: string) {
  const d = await db();
  await d.execute("UPDATE sessions SET folder_id = NULL WHERE folder_id = $1", [id]);
  await d.execute("DELETE FROM folders WHERE id = $1", [id]);
}

export async function moveSession(id: string, folderId: string | null) {
  await (await db()).execute("UPDATE sessions SET folder_id = $1 WHERE id = $2", [folderId, id]);
}

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const rows: MessageRow[] = await (await db()).select(
    "SELECT id, role, content, thinking, tool_calls, tool_name FROM messages WHERE session_id = $1 ORDER BY id",
    [sessionId],
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    ...(r.thinking && { thinking: r.thinking }),
    ...(r.tool_calls && { tool_calls: JSON.parse(r.tool_calls) }),
    ...(r.tool_name && { tool_name: r.tool_name }),
  }));
}

export async function addMessage(sessionId: string, m: Message) {
  const d = await db();
  const now = Date.now();
  await d.execute(
    "INSERT INTO messages (session_id, role, content, thinking, tool_calls, tool_name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      sessionId,
      m.role,
      m.content,
      m.thinking || null,
      m.tool_calls?.length ? JSON.stringify(m.tool_calls) : null,
      m.tool_name ?? null,
      now,
    ],
  );
  await d.execute("UPDATE sessions SET updated_at = $1 WHERE id = $2", [now, sessionId]);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows: { value: string }[] = await (await db()).select("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? (JSON.parse(rows[0].value) as T) : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await (await db()).execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}
