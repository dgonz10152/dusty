import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { getSetting, setSetting } from "../db";
import { DEFAULT_HOST } from "../agent";
import { EMPTY_PROFILE, type Profile } from "../prompts";

const PROFILE_FIELDS: { key: keyof Profile; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: "name", label: "Name", placeholder: "Alex" },
  { key: "year", label: "Year", placeholder: "Sophomore" },
  { key: "school", label: "School", placeholder: "University of Texas at Austin" },
  { key: "major", label: "Major", placeholder: "Computer Science" },
  { key: "courses", label: "Current courses", placeholder: "CS 439 Operating Systems, M 340L Linear Algebra", multiline: true },
  { key: "learningStyle", label: "How you like to learn", placeholder: "Visual examples first, then the math", multiline: true },
  { key: "notes", label: "Anything else", placeholder: "Strong in calculus, rusty on proofs", multiline: true },
];

export default function Settings({ onClose }: { onClose: (saved: boolean) => void }) {
  const [host, setHost] = useState(DEFAULT_HOST);
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [error, setError] = useState("");

  useEffect(() => {
    getSetting("host", DEFAULT_HOST).then(setHost);
    getSetting<Profile>("profile", EMPTY_PROFILE).then((p) => setProfile({ ...EMPTY_PROFILE, ...p }));
    invoke<string | null>("get_api_key").then((k) => setHasKey(!!k));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    try {
      const url = new URL(host.trim());
      await setSetting("host", url.origin);
      await setSetting("profile", profile);
      if (key.trim()) await invoke("set_api_key", { key: key.trim() });
      onClose(true);
    } catch (e) {
      setError(e instanceof TypeError ? "Host must be a full URL, like https://ollama.com" : String(e));
    }
  }

  async function removeKey() {
    await invoke("set_api_key", { key: "" });
    setHasKey(false);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="modal" role="dialog" aria-labelledby="settings-title">
        <header className="modal-header">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" aria-label="Close" onClick={() => onClose(false)}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">
          <section>
            <h3>Ollama</h3>
            <label className="field">
              <span>Host</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} />
              <small>Ollama Cloud is https://ollama.com. A local Ollama runs at http://localhost:11434.</small>
            </label>
            <label className="field">
              <span>API key</span>
              <div className="field-row">
                <input
                  type="password"
                  value={key}
                  placeholder={hasKey ? "Saved in your Keychain" : "Paste a key from ollama.com/settings/keys"}
                  onChange={(e) => setKey(e.target.value)}
                  spellCheck={false}
                />
                {hasKey && (
                  <button className="btn ghost" onClick={removeKey}>
                    Remove
                  </button>
                )}
              </div>
            </label>
          </section>
          <section>
            <h3>About me</h3>
            <p className="muted">Dusty uses this to pitch lessons at the right level.</p>
            {PROFILE_FIELDS.map((f) => (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                {f.multiline ? (
                  <textarea
                    rows={2}
                    value={profile[f.key]}
                    placeholder={f.placeholder}
                    onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                  />
                ) : (
                  <input
                    value={profile[f.key]}
                    placeholder={f.placeholder}
                    onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                  />
                )}
              </label>
            ))}
          </section>
        </div>
        <footer className="modal-footer">
          {error && <span className="error-text">{error}</span>}
          <button className="btn ghost" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
