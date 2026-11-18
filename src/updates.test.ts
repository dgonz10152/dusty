import { test } from "node:test";
import assert from "node:assert/strict";
import { installable, Updates, type Release } from "./updates.ts";

const stable: Release = { tag: "v0.2.0", version: "0.2.0", prerelease: false };
const beta: Release = { tag: "v0.3.0-beta.1", version: "0.3.0-beta.1", prerelease: true };
const feed = (current = "0.1.0", releases = [beta, stable]) => async () => ({ current, releases });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("update checks coalesce and quiet failures do not interrupt studying", async () => {
  const found = deferred<null>();
  let calls = 0;
  const updates = new Updates(feed(), () => { calls++; return found.promise; }, async () => {});
  const first = updates.check(true);
  assert.equal(updates.check(), first);
  found.resolve(null);
  await first;
  assert.equal(calls, 1);
  assert.equal(updates.state.phase, "current");
  const offline = new Updates(async () => { throw new Error("offline"); }, async () => null, async () => {});
  await offline.check(true);
  assert.equal(offline.state.phase, "idle");
  assert.equal(offline.state.error, undefined);
  await offline.check();
  assert.equal(offline.state.phase, "error");
  assert.match(offline.state.error!, /offline/);
});

test("installation waits for work, reports progress, coalesces clicks and restarts once", async () => {
  const finish = deferred<void>();
  let downloads = 0, restarts = 0;
  const updates = new Updates(feed(), async () => ({
    version: "0.2.0", body: "New features", close: async () => {},
    downloadAndInstall: async (event) => {
      downloads++;
      event?.({ event: "Started", data: { contentLength: 100 } });
      event?.({ event: "Progress", data: { chunkLength: 40 } });
      await finish.promise;
      event?.({ event: "Finished" });
    },
  }), async () => { restarts++; });
  await updates.check();
  await updates.install(() => true);
  assert.equal(downloads, 0);
  const installing = updates.install(() => false);
  assert.equal(updates.install(() => false), installing);
  await Promise.resolve();
  assert.equal(updates.state.downloaded, 40);
  assert.equal(updates.state.total, 100);
  finish.resolve();
  await installing;
  assert.equal(downloads, 1);
  assert.equal(restarts, 1);
  assert.equal(updates.state.phase, "ready");
});

test("download and signature failures never restart; restart failures can retry without reinstalling", async () => {
  for (const reason of ["network unavailable", "invalid signature"]) {
    let restarts = 0, downloads = 0;
    const updates = new Updates(feed(), async () => ({
      version: "0.2.0", close: async () => {},
      downloadAndInstall: async () => { if (++downloads === 1) throw new Error(reason); },
    }), async () => { restarts++; });
    await updates.check();
    await updates.install(() => false);
    assert.equal(updates.state.phase, "error");
    assert.match(updates.state.error!, new RegExp(reason));
    assert.equal(restarts, 0);
    await updates.install(() => false);
    assert.equal(restarts, 1);
  }
  let downloads = 0, restarts = 0;
  const updates = new Updates(feed(), async () => ({ version: "0.2.0", close: async () => {}, downloadAndInstall: async () => { downloads++; } }),
    async () => { if (++restarts === 1) throw new Error("restart failed"); });
  await updates.check();
  await updates.install(() => false);
  assert.equal(updates.state.phase, "ready");
  assert.match(updates.state.error!, /Couldn't restart/);
  await updates.install(() => false);
  assert.equal(downloads, 1);
  assert.equal(restarts, 2);
});

test("stable builds follow stable releases, prerelease builds follow prereleases", async () => {
  const asked: [string, boolean][] = [];
  const find = async (tag: string, any: boolean) => { asked.push([tag, any]); return null; };
  await new Updates(feed("0.1.0"), find, async () => {}).check();
  await new Updates(feed("0.2.0-beta.1"), find, async () => {}).check();
  assert.deepEqual(asked, [["v0.2.0", false], ["v0.3.0-beta.1", false]]);
});

test("users can switch to any listed version, and mismatched feeds are rejected and closed", async () => {
  let version = "0.3.0-beta.1", closed = 0;
  const asked: [string, boolean][] = [];
  const updates = new Updates(feed(), async (tag, any) => { asked.push([tag, any]); return { version, close: async () => { closed++; }, downloadAndInstall: async () => {} }; }, async () => {});
  await updates.check();
  assert.equal(updates.state.phase, "error");
  assert.match(updates.state.error!, /v0\.2\.0 update feed announced version 0\.3\.0-beta\.1/);
  assert.equal(closed, 1);
  await updates.choose("v0.3.0-beta.1");
  assert.deepEqual(asked.at(-1), ["v0.3.0-beta.1", true]);
  assert.equal(updates.state.phase, "available");
  assert.equal(updates.state.chosen, true);
  await updates.choose("v9.9.9");
  assert.equal(asked.length, 2);
  version = "0.2.0";
  await updates.check();
  assert.equal(updates.state.chosen, false);
  assert.equal(closed, 2);
});

test("only published releases with a feed are installable", () => {
  const asset = (name: string) => ({ name });
  assert.deepEqual(installable([
    { tag_name: "v0.3.0-beta.1", draft: false, prerelease: true, assets: [asset("latest.json")] },
    { tag_name: "v0.2.1", draft: true, prerelease: false, assets: [asset("latest.json")] },
    { tag_name: "v0.1.0", draft: false, prerelease: true, assets: [asset("Dusty_0.1.0_x64.dmg")] },
  ]), [beta]);
});
