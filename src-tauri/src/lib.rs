use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

const KEYRING_SERVICE: &str = "dev.danielgonzalez.dusty";
const KEYRING_USER: &str = "ollama-api-key";

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    match key_entry()?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = key_entry()?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(&key).map_err(|e| e.to_string())
}

const CLAUDE_MODELS: &[&str] = &["opus", "sonnet", "haiku"];

/// GUI apps on macOS don't get the shell's PATH, so ask a login shell where `claude` lives.
// ponytail: login (not interactive) shell plus known install dirs; PATH set only in .zshrc falls through to the fallbacks
fn claude_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = std::process::Command::new(shell)
            .args(["-lc", "command -v claude"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()));
        let home = std::env::var("HOME").unwrap_or_default();
        from_shell
            .into_iter()
            .chain([
                PathBuf::from(&home).join(".local/bin/claude"),
                PathBuf::from(&home).join(".claude/local/claude"),
                PathBuf::from("/opt/homebrew/bin/claude"),
                PathBuf::from("/usr/local/bin/claude"),
            ])
            .find(|p| p.is_absolute() && p.is_file())
    })
    .as_ref()
}

#[tauri::command]
async fn claude_available() -> bool {
    // The first lookup spawns a login shell, so keep it off the main thread.
    tauri::async_runtime::spawn_blocking(|| claude_path().is_some())
        .await
        .unwrap_or(false)
}

/// Cancel handles for in-flight `claude` runs, keyed by the caller's run id.
#[derive(Default)]
struct ClaudeRuns(Mutex<HashMap<String, oneshot::Sender<()>>>);

/// Runs one headless Claude Code turn and streams its stream-json lines to `on_event`.
/// Rust builds every flag so the webview can only choose the model, prompts, and run kind.
#[tauri::command]
async fn claude_run(
    app: tauri::AppHandle,
    runs: State<'_, ClaudeRuns>,
    run_id: String,
    kind: String,
    model: String,
    system: String,
    input: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    if !CLAUDE_MODELS.contains(&model.as_str()) {
        return Err(format!("Unknown Claude model: {model}"));
    }
    let tools = match kind.as_str() {
        "teach" => "",
        "research" => "WebSearch,WebFetch",
        _ => return Err(format!("Unknown run kind: {kind}")),
    };
    let bin = claude_path().ok_or("Claude Code isn't installed")?;
    // An empty working dir keeps any CLAUDE.md out of the conversation.
    let cwd = app.path().app_data_dir().map_err(|e| e.to_string())?.join("claude");
    std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(bin);
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Thinking text is omitted in print mode unless asked for; summaries are what the API offers.
        "--thinking-display",
        "summarized",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--model",
        &model,
        "--system-prompt",
        &system,
        "--tools",
        tools,
    ]);
    if !tools.is_empty() {
        cmd.args(["--allowedTools", tools]);
    }
    let mut child = cmd
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;

    let mut stdin = child.stdin.take().unwrap();
    tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await;
    });
    let mut stderr = child.stderr.take().unwrap();
    let stderr = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    runs.0.lock().unwrap().insert(run_id.clone(), cancel_tx);
    let streamed = tokio::select! {
        _ = &mut cancel_rx => Err("Cancelled".to_string()),
        r = async {
            while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
                on_event.send(line).map_err(|e| e.to_string())?;
            }
            Ok(())
        } => r,
    };
    runs.0.lock().unwrap().remove(&run_id);
    if streamed.is_err() {
        let _ = child.kill().await;
        return streamed;
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    let err = stderr.await.unwrap_or_default();
    Err(match err.trim() {
        "" => format!("Claude Code exited with {status}"),
        e => e.to_string(),
    })
}

#[tauri::command]
fn claude_stop(runs: State<'_, ClaudeRuns>, run_id: String) {
    if let Some(tx) = runs.0.lock().unwrap().remove(&run_id) {
        let _ = tx.send(());
    }
}

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_initial_tables",
        sql: "
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
                content TEXT NOT NULL DEFAULT '',
                thinking TEXT,
                tool_calls TEXT,
                tool_name TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX messages_session ON messages(session_id, id);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "add_folders",
        sql: "
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            ALTER TABLE sessions ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
        ",
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "add_exams",
        sql: "
            ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson', 'exam'));
            ALTER TABLE sessions ADD COLUMN parent_id TEXT;
            ALTER TABLE sessions ADD COLUMN node_id TEXT;
            ALTER TABLE sessions ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
            CREATE TABLE materials (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                content TEXT NOT NULL
            );
            CREATE INDEX materials_session ON materials(session_id);
        ",
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:dusty.db", migrations())
                .build(),
        )
        .manage(ClaudeRuns::default())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            claude_available,
            claude_run,
            claude_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
