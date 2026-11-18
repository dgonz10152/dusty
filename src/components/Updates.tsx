import { useEffect, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { installable, Updates, type GitHubRelease } from "../updates";
import Markdown from "./Markdown";

async function releases() {
  const res = await fetch("https://api.github.com/repos/dgonz10152/dusty/releases?per_page=100", {
    headers: { Accept: "application/vnd.github+json" }, connectTimeout: 15_000,
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);
  return { current: await getVersion(), releases: installable(await res.json() as GitHubRelease[]) };
}

async function find(tag: string, any: boolean) {
  const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>("release_update", { tag, switch: any });
  return metadata && new Update(metadata);
}

const updates = new Updates(releases, find, relaunch);
let launchChecked = false;

export function useUpdates() {
  const state = useSyncExternalStore(updates.subscribe, updates.snapshot);
  useEffect(() => {
    if (!isTauri()) return;
    if (!launchChecked) {
      launchChecked = true;
      void updates.check(true);
    }
  }, []);
  return { state, updates };
}

export type UpdateControls = ReturnType<typeof useUpdates> & { blocked: boolean };

export function UpdateSettings({ state, updates, blocked }: UpdateControls) {
  const working = state.phase === "downloading" || state.phase === "installing";
  const busy = working || state.phase === "checking" || state.phase === "ready";
  const selected = state.releases.find((r) => r.version === state.version)?.tag ?? "";
  return <section className="update-settings">
    <h3>Dusty {state.current && <span className="muted">{state.current}</span>}</h3>
    {state.releases.length > 0 && <label className="field">
      <span>Version</span>
      <select value={selected} disabled={busy} onChange={(e) => void updates.choose(e.target.value)}>
        <option value="" disabled>Choose a version</option>
        {state.releases.map((r) => <option key={r.tag} value={r.tag} disabled={r.version === state.current}>
          {r.version}{r.prerelease ? " (pre-release)" : ""}{r.version === state.current ? " (installed)" : ""}
        </option>)}
      </select>
      <small>Pre-releases get new features first and may be less stable.</small>
    </label>}
    {state.version && <p>Version {state.version} is {state.chosen ? "ready to install" : "available"}.</p>}
    {state.notes && <details><summary>Release notes</summary><Markdown text={state.notes} /></details>}
    {state.phase === "current" && <p className="muted" role="status">You're up to date.</p>}
    {state.error && <p className="error-text" role="alert">{state.error}</p>}
    <div className="update-actions">
      <button className="btn ghost" disabled={busy} onClick={() => void updates.check()}>
        {state.phase === "checking" ? "Checking…" : "Check for updates"}
      </button>
      {state.version && <button className="btn primary" disabled={blocked || working || state.phase === "checking"} onClick={() => void updates.install(() => blocked)}>
        {state.phase === "ready" ? "Restart Dusty" : state.chosen ? "Install and restart" : "Update and restart"}
      </button>}
    </div>
    {state.version && blocked && <p className="muted">Finish active requests and save, send, or clear unsaved input before updating.</p>}
    {working && <UpdateProgress state={state} />}
  </section>;
}

export function UpdateProgress({ state }: Pick<UpdateControls, "state">) {
  return <div role="status" aria-live="polite">
    <p>{state.phase === "installing" ? "Installing update…" : "Downloading update…"}</p>
    <progress max={state.total || undefined} value={state.total ? state.downloaded : undefined} aria-label="Update download" />
    {state.phase === "downloading" && <small>{(state.downloaded / 1024 / 1024).toFixed(1)} MB{state.total ? ` of ${(state.total / 1024 / 1024).toFixed(1)} MB` : ""}</small>}
  </div>;
}
