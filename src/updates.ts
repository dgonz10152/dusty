import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

type Package = Pick<Update, "version" | "body" | "downloadAndInstall" | "close">;
export type Release = { tag: string; version: string; prerelease: boolean };
export type GitHubRelease = { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string }[] };
type Feed = { current: string; releases: Release[] };
type Found = { release?: Release; update: Package | null; chosen: boolean };

/** Releases the updater can install: published ones that carry their own signed feed, newest first. */
// ponytail: GitHub's created_at order stands in for semver order; Rust still refuses non-newer automatic updates.
export function installable(releases: GitHubRelease[]): Release[] {
  return releases.filter((r) => !r.draft && r.assets.some((a) => a.name === "latest.json"))
    .map((r) => ({ tag: r.tag_name, version: r.tag_name.replace(/^v/, ""), prerelease: r.prerelease }));
}

export type UpdateState = {
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "ready" | "error";
  current?: string;
  releases: Release[];
  /** The user picked this version, which may be older than the installed one. */
  chosen?: boolean;
  version?: string;
  notes?: string;
  downloaded: number;
  total?: number;
  error?: string;
};

/** Shared by the launch notice and Settings; duplicate checks/install clicks are coalesced. */
export class Updates {
  state: UpdateState = { phase: "idle", releases: [], downloaded: 0 };
  private listeners = new Set<() => void>();
  private checking?: Promise<void>;
  private installing?: Promise<void>;
  private update?: Package;
  private installed = false;

  private list: () => Promise<Feed>;
  /** `any` accepts any other version (switching); otherwise only a newer one. */
  private find: (tag: string, any: boolean) => Promise<Package | null>;
  private relaunch: () => Promise<void>;

  constructor(list: () => Promise<Feed>, find: (tag: string, any: boolean) => Promise<Package | null>, relaunch: () => Promise<void>) {
    this.list = list;
    this.find = find;
    this.relaunch = relaunch;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.state;

  private set(state: Partial<UpdateState>) {
    this.state = { ...this.state, ...state };
    this.listeners.forEach((listener) => listener());
  }

  check(quiet = false): Promise<void> {
    return this.run(quiet, async () => {
      const { current, releases } = await this.list();
      this.set({ current, releases });
      // Prerelease builds follow newer prereleases; stable builds only follow stable releases.
      const release = releases.find((r) => !r.prerelease || current.includes("-"));
      return { release, update: release ? await this.find(release.tag, false) : null, chosen: false };
    });
  }

  /** Switch to a specific listed release, including older prereleases. */
  choose(tag: string): Promise<void> {
    const release = this.state.releases.find((r) => r.tag === tag);
    if (!release) return Promise.resolve();
    return this.run(false, async () => ({ release, update: await this.find(tag, true), chosen: true }));
  }

  private run(quiet: boolean, work: () => Promise<Found>): Promise<void> {
    if (this.checking) return this.checking;
    if (this.installing || this.installed) return Promise.resolve();
    const previous = this.state;
    this.set({ phase: "checking", error: undefined });
    this.checking = Promise.resolve().then(async () => {
      try {
        const { release, update, chosen } = await work();
        if (update && update.version !== release?.version) {
          await update.close();
          throw new Error(`The ${release?.tag} update feed announced version ${update.version}.`);
        }
        await this.update?.close();
        this.update = update ?? undefined;
        this.set({ phase: update ? "available" : "current", version: update?.version, notes: update?.body, chosen, downloaded: 0, total: undefined });
      } catch (e) {
        if (quiet) this.set({ phase: previous.phase, error: previous.error });
        else this.set({ phase: "error", error: `Couldn't check for updates. ${errorText(e)}` });
      } finally {
        this.checking = undefined;
      }
    });
    return this.checking;
  }

  install(blocked: () => boolean): Promise<void> {
    if (this.installing) return this.installing;
    if (blocked() || !this.update || this.checking) return Promise.resolve();
    this.set({ phase: this.installed ? "ready" : "downloading", downloaded: 0, total: undefined, error: undefined });
    this.installing = Promise.resolve().then(async () => {
      try {
        if (!this.installed) {
          await this.update!.downloadAndInstall((event: DownloadEvent) => {
            if (event.event === "Started") this.set({ total: event.data.contentLength });
            if (event.event === "Progress") this.set({ downloaded: this.state.downloaded + event.data.chunkLength });
            if (event.event === "Finished") this.set({ phase: "installing" });
          }, { timeout: 120_000 });
          this.installed = true;
          this.set({ phase: "ready" });
        }
        await this.relaunch();
      } catch (e) {
        this.set({ phase: this.installed ? "ready" : "error", error: this.installed
          ? `Update installed. Couldn't restart Dusty. Try restarting again. ${errorText(e)}`
          : `Couldn't install the update. ${errorText(e)}` });
      } finally {
        this.installing = undefined;
      }
    });
    return this.installing;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
