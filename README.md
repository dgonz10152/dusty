# Dusty

Dusty is a desktop AI tutor that teaches for understanding, not memorization.
Ask it to teach you anything and it finds what you already know, plans a path from first principles, then teaches it one idea at a time with quizzes along the way.

## Credit

The teaching approach comes from [amosblomqvist/learn](https://github.com/amosblomqvist/learn), a personal learning setup for the [pi](https://github.com/earendil-works/pi) agent.
Amos explains it in [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).
Dusty ports its `teach` and `visualize` skills, its `researcher` agent, and its `quiz` and `ask_user_question` extensions into a standalone app.
All credit for the method goes to Amos Blomqvist.

## How it teaches

Every lesson runs in three phases:

1. **Probe** - graded quizzes map the edge of what you know, and questions pin down what you actually want to learn.
2. **Plan** - Dusty proposes an approach and a dependency map (unconditional truths at the roots, your goal at the end) and waits for your go-ahead.
3. **Teach** - each idea is motivated, established, connected to what came before, and checked with a quiz before moving on.

Two principles drive it: start from truths you can accept without caveats, and make every step feel like something you could have discovered yourself.

## Features

- Interactive quiz cards with instant grading, an "I don't know" option, and a note field
- A `research` tool that fact-checks claims with web search before teaching them
- Markdown rendering with LaTeX math, Mermaid diagrams, and SVG figures
- An "About me" profile (school, year, major, courses, learning style) so lessons start at the right level
- Lessons saved locally in SQLite, and a pending quiz survives restarting the app
- API key stored in the OS keychain

## Stack

- [Tauri 2](https://tauri.app) with React 19, TypeScript, and Vite
- Pluggable model providers (`src/providers/`): [Ollama](https://ollama.com), [Claude Code](https://claude.com/claude-code), and [Codex](https://developers.openai.com/codex/cli/)
- `tauri-plugin-sql` (SQLite), `tauri-plugin-http`, and `keyring`

## Getting started

Prerequisites: Node.js, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev
```

Then open **Settings** and fill in **About me**, and pick a model from the picker under the message box.

### Claude models

Install [Claude Code](https://claude.com/claude-code) and run `claude` once in a terminal to sign in.
Dusty finds it on its own and lists Opus, Sonnet, and Haiku in the picker, using your Claude plan.
Each turn runs headless `claude -p` with no tools, and research uses its built-in web search.

### Codex models

Install [Codex CLI](https://developers.openai.com/codex/cli/) and run `codex login` in a terminal.
Restart Dusty, then select **Codex · default** in the study model picker.
Dusty uses Codex's configured model and saved sign-in, subject to your account's access and usage limits.
Teaching, quizzes, hints, titles, research, and image transcription run through ephemeral, read-only CLI turns; research enables live web search.
If Dusty asks you to update Codex, install a current CLI version and try again.

### Ollama models

Paste an API key from [ollama.com/settings/keys](https://ollama.com/settings/keys) in **Settings**, then pick a model that supports tool calling.

To use a local Ollama instead, set the host in Settings to `http://localhost:11434`.
The `research` tool still needs an ollama.com key, since web search is a cloud API.

## Development

```sh
npm test            # unit tests (node --test)
npx tsc --noEmit    # type-check
npm run tauri build # production bundle
```

## Releases

Publishing a GitHub release or prerelease runs the **Release builds** workflow and attaches Windows x64 installers (`.exe` and `.msi`) and separate macOS Apple Silicon (`aarch64`) and Intel (`x64`) `.dmg` downloads to that release.
Saving a draft does not start builds.

1. Update the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, and refresh the npm and Cargo lockfiles.
2. Commit and push those changes, including the release workflow, before creating the release tag.
3. Create a GitHub release with a matching version tag (for example, `v0.1.0`) pointing to that commit, then publish it.
4. Follow **Actions > Release builds** for progress, then find downloads under the release's **Assets**.

Each platform uploads as it finishes, so assets may appear at different times.
If a job fails, inspect its log and use **Re-run failed jobs** on that workflow run; successful platforms are not canceled by another platform's failure.
The workflow builds the tagged source and uses the versions in the manifests; it does not bump versions automatically.
No additional secrets are required: uploads use the built-in `GITHUB_TOKEN` with `contents: write` permission.

macOS builds use the existing ad-hoc signature without notarization, and Windows installers are unsigned, so OS security prompts are expected.
Verify installation on Windows and both Mac architectures before treating a release as tested.
Claude Code and Codex discovery currently uses Unix paths; producing a Windows installer does not verify those integrations on Windows.

## Roadmap

- Canvas integration, so lessons can use your course's lecture slides and textbook as a source of truth
- More model providers
