use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
};
use tauri::{State, ipc::Channel};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::oneshot,
};

fn codex_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = std::process::Command::new(shell)
            .args(["-lc", "command -v codex"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()));
        let home = std::env::var("HOME").unwrap_or_default();
        from_shell
            .into_iter()
            .chain([
                PathBuf::from(&home).join(".local/bin/codex"),
                PathBuf::from(&home).join(".npm-global/bin/codex"),
                PathBuf::from("/opt/homebrew/bin/codex"),
                PathBuf::from("/usr/local/bin/codex"),
            ])
            .find(|p| p.is_absolute() && p.is_file())
    })
    .as_ref()
}

#[tauri::command]
pub async fn codex_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| codex_path().is_some())
        .await
        .unwrap_or(false)
}

// Discover the account's catalog through the CLI instead of maintaining model names here.
async fn discover_models(bin: &Path) -> Result<Vec<String>, String> {
    let mut child = Command::new(bin)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let discovery = async {
        let init = serde_json::json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "dusty", "version": env!("CARGO_PKG_VERSION")}
        }});
        stdin
            .write_all(format!("{init}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut models = vec!["default".to_string()];
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            let Ok(response) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(id) = response["id"].as_u64() else {
                continue;
            };
            if id != 1 && id != 2 {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(error.to_string());
            }
            if id == 1 {
                stdin
                    .write_all(b"{\"method\":\"initialized\"}\n")
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                let data = response["result"]["data"]
                    .as_array()
                    .ok_or("Invalid Codex model list")?;
                for model in data {
                    if model["hidden"].as_bool() == Some(true) {
                        continue;
                    }
                    let name = model["model"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Invalid Codex model name")?;
                    if !models.iter().any(|m| m == name) {
                        models.push(name.to_string());
                    }
                }
                if response["result"]["nextCursor"].as_str().is_none() {
                    return Ok(models);
                }
            }
            let cursor = if id == 2 {
                response["result"]["nextCursor"].clone()
            } else {
                Value::Null
            };
            let request = serde_json::json!({"id": 2, "method": "model/list", "params": {"cursor": cursor, "includeHidden": false}});
            stdin
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
        }
        Err("Codex exited before returning models".into())
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), discovery)
        .await
        .unwrap_or_else(|_| Err("Codex model discovery timed out".into()));
    let _ = child.kill().await;
    result
}

#[tauri::command]
pub async fn codex_models() -> Result<Vec<String>, String> {
    let bin = tauri::async_runtime::spawn_blocking(|| codex_path().cloned())
        .await
        .map_err(|e| e.to_string())?;
    match bin {
        Some(bin) => discover_models(&bin).await.map_err(friendly_error),
        None => Ok(vec![]),
    }
}

#[derive(Default)]
pub struct CodexRuns(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Deserialize)]
pub struct Image {
    mime: String,
    bytes: Vec<u8>,
}

// Own the directory so image cleanup also happens on spawn failure and cancellation.
struct WorkDir(PathBuf);
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
impl WorkDir {
    fn new() -> Result<Self, String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("dusty-codex-{}-{stamp}-{id}", std::process::id()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|e| e.to_string())?;
        Ok(Self(path))
    }
    fn image(&self, image: &Image) -> Result<PathBuf, String> {
        let ext = match image.mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => return Err("Unsupported image type".into()),
        };
        if image.bytes.is_empty() || image.bytes.len() > 20 * 1024 * 1024 {
            return Err("Image must be between 1 byte and 20 MB".into());
        }
        let path = self.0.join(format!("input.{ext}"));
        std::fs::write(&path, &image.bytes).map_err(|e| e.to_string())?;
        Ok(path)
    }
}

fn args(kind: &str, model: &str) -> Result<Vec<String>, String> {
    if model.is_empty() || model.starts_with('-') || model.chars().any(char::is_whitespace) {
        return Err("Unknown Codex model".into());
    }
    if !["teach", "research", "transcribe"].contains(&kind) {
        return Err("Unknown Codex run kind".into());
    }
    // Preserve the configured model and authentication, but keep teaching out of the shell.
    let mut argv: Vec<String> = [
        "--ask-for-approval",
        "never",
        "-c",
        "features.shell_tool=false",
        "-c",
        if kind == "research" {
            "web_search=\"live\""
        } else {
            "web_search=\"disabled\""
        },
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if model != "default" {
        argv.extend(["--model".into(), model.into()]);
    }
    Ok(argv)
}

#[derive(Default)]
struct Output {
    text: String,
    completed: bool,
    error: Option<String>,
}
impl Output {
    fn event(&mut self, line: &str) {
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match ev["type"].as_str().unwrap_or_default() {
            "item.completed" if ev["item"]["type"] == "agent_message" => {
                if let Some(text) = ev["item"]["text"].as_str() {
                    self.text = text.into();
                }
            }
            "turn.completed" => self.completed = true,
            "turn.failed" => {
                self.error = Some(
                    ev["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex turn failed")
                        .into(),
                )
            }
            "error" => self.error = Some(ev["message"].as_str().unwrap_or("Codex failed").into()),
            _ => {}
        }
    }
    fn finish(self) -> Result<String, String> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if !self.completed {
            return Err(
                "Codex exited without completing its turn. Update Codex CLI and try again.".into(),
            );
        }
        if self.text.trim().is_empty() {
            return Err("Codex returned no assistant reply".into());
        }
        Ok(self.text)
    }
}

async fn execute(
    bin: &Path,
    argv: Vec<String>,
    system: String,
    input: String,
    image: Option<Image>,
    on_event: Channel<String>,
    mut cancel: oneshot::Receiver<()>,
) -> Result<String, String> {
    let cwd = WorkDir::new()?;
    let image = image.as_ref().map(|i| cwd.image(i)).transpose()?;
    let mut cmd = Command::new(bin);
    cmd.args(argv);
    if let Some(image) = image {
        cmd.arg("--image").arg(image);
    }
    let mut child = cmd
        .arg("-")
        .current_dir(&cwd.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Couldn't start Codex: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let work = async {
        let write = async move {
            stdin
                .write_all(format!("{system}\n\n{input}").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            drop(stdin);
            Ok::<_, String>(())
        };
        let read = async {
            let mut output = Output::default();
            while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
                output.event(&line);
                on_event.send(line).map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(output)
        };
        let errors = async {
            let mut text = String::new();
            stderr
                .read_to_string(&mut text)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(text)
        };
        let (_, output, errors) = tokio::try_join!(write, read, errors)?;
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(if errors.trim().is_empty() {
                format!("Codex exited with {status}")
            } else {
                errors
            });
        }
        output.finish()
    };
    let result = tokio::select! { biased; _ = &mut cancel => Err("Cancelled".into()), result = work => result };
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

fn friendly_error(error: String) -> String {
    let lower = error.to_lowercase();
    if lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("not logged in")
        || lower.contains("authentication")
    {
        return "Codex: Sign in with `codex login` in a terminal, then try again.".into();
    }
    if lower.contains("unexpected argument") || lower.contains("unrecognized") {
        return format!("Codex: Update Codex CLI to use it with Dusty. {error}");
    }
    format!("Codex: {error}")
}

#[tauri::command]
pub async fn codex_run(
    runs: State<'_, CodexRuns>,
    run_id: String,
    kind: String,
    model: String,
    system: String,
    input: String,
    image: Option<Image>,
    on_event: Channel<String>,
) -> Result<String, String> {
    let argv = args(&kind, &model).map_err(friendly_error)?;
    if (kind == "transcribe") != image.is_some() {
        return Err("Codex: Image required only for transcription".into());
    }
    let (tx, rx) = oneshot::channel();
    {
        let mut active = runs.0.lock().unwrap();
        if active.contains_key(&run_id) {
            return Err("Codex: Duplicate run id".into());
        }
        active.insert(run_id.clone(), tx);
    }
    let result = async {
        let bin = tauri::async_runtime::spawn_blocking(|| codex_path().cloned())
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Codex CLI isn't installed. Install it, run codex login, then restart Dusty.")?;
        execute(&bin, argv, system, input, image, on_event, rx).await
    }
    .await;
    runs.0.lock().unwrap().remove(&run_id);
    result.map_err(friendly_error)
}

#[tauri::command]
pub fn codex_stop(runs: State<'_, CodexRuns>, run_id: String) {
    if let Some(tx) = runs.0.lock().unwrap().remove(&run_id) {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_permissions_and_validation() {
        let teach = args("teach", "default").unwrap().join(" ");
        assert!(teach.contains("--sandbox read-only"));
        assert!(teach.contains("--ephemeral"));
        assert!(!teach.contains("--model"));
        assert!(
            args("research", "default")
                .unwrap()
                .contains(&"web_search=\"live\"".into())
        );
        assert!(args("bad", "default").is_err());
        assert!(args("teach", "").is_err());
        assert!(args("teach", "--bad").is_err());
        assert!(args("teach", "bad model").is_err());
        let named = args("teach", "test-model").unwrap();
        assert_eq!(&named[named.len() - 2..], ["--model", "test-model"]);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_initializes_and_paginates() {
        use std::os::unix::fs::PermissionsExt;
        let dir = WorkDir::new().unwrap();
        let bin = dir.0.join("codex");
        std::fs::write(&bin, r##"#!/bin/sh
read -r init
case "$init" in *initialize*) ;; *) exit 1;; esac
echo '{"id":1,"result":{}}'
read -r initialized
case "$initialized" in *initialized*) ;; *) exit 2;; esac
read -r request
case "$request" in *model/list*) ;; *) exit 3;; esac
echo '{"id":2,"result":{"data":[{"model":"test-a"},{"model":"hidden","hidden":true}],"nextCursor":"page2"}}'
read -r request
case "$request" in *page2*) ;; *) exit 4;; esac
echo '{"id":2,"result":{"data":[{"model":"test-a"},{"model":"test-b"}],"nextCursor":null}}'
"##).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            discover_models(&bin).await.unwrap(),
            ["default", "test-a", "test-b"]
        );
        std::fs::write(
            &bin,
            "#!/bin/sh\nread -r init\necho '{\"id\":1,\"error\":{\"message\":\"failure\"}}'\n",
        )
        .unwrap();
        assert!(discover_models(&bin).await.unwrap_err().contains("failure"));
    }

    #[test]
    fn output_requires_success_and_reply() {
        let mut out = Output::default();
        out.event(r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}"#);
        out.event(r#"{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}"#);
        out.event(r#"{"type":"turn.completed"}"#);
        assert_eq!(out.finish().unwrap(), "Hello");
        assert!(Output::default().finish().is_err());
        assert!(
            Output {
                completed: true,
                ..Output::default()
            }
            .finish()
            .is_err()
        );
        let mut failed = Output::default();
        failed.event(r#"{"type":"turn.failed","error":{"message":"rate limit"}}"#);
        assert_eq!(failed.finish().unwrap_err(), "rate limit");
    }
    #[test]
    fn image_is_removed_on_scope_exit() {
        let path;
        {
            let dir = WorkDir::new().unwrap();
            path = dir
                .image(&Image {
                    mime: "image/png".into(),
                    bytes: vec![1, 2, 3],
                })
                .unwrap();
            assert!(path.exists());
            assert!(
                dir.image(&Image {
                    mime: "text/plain".into(),
                    bytes: vec![1]
                })
                .is_err()
            );
        }
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn process_reads_stdin_and_cleans_image_on_success_and_failure() {
        for fail in [false, true] {
            let script = if fail {
                "cat >/dev/null; echo 'not logged in' >&2; exit 1"
            } else {
                r#"cat >/dev/null; test -f input.png || exit 2; printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$PWD"; printf '{"type":"turn.completed"}\n'"#
            };
            let (_tx, rx) = oneshot::channel();
            let result = execute(
                Path::new("/bin/sh"),
                vec!["-c".into(), script.into()],
                "instructions".into(),
                "prompt".into(),
                Some(Image {
                    mime: "image/png".into(),
                    bytes: vec![1],
                }),
                Channel::new(|_| Ok(())),
                rx,
            )
            .await;
            if fail {
                assert!(friendly_error(result.unwrap_err()).contains("codex login"));
            } else {
                assert!(!Path::new(&result.unwrap()).exists());
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_process_and_cleans_image() {
        let (tx, rx) = oneshot::channel();
        tx.send(()).unwrap();
        let result = execute(
            Path::new("/bin/sh"),
            vec!["-c".into(), "sleep 30".into()],
            "".into(),
            "".into(),
            Some(Image {
                mime: "image/png".into(),
                bytes: vec![1],
            }),
            Channel::new(|_| Ok(())),
            rx,
        )
        .await;
        assert_eq!(result.unwrap_err(), "Cancelled");
    }
}
