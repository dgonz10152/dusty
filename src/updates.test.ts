import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, installable, Updates, type Release } from "./updates.ts";

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

test("releases are ordered by semantic version, not publish order", () => {
  const asset = [{ name: "latest.json" }];
  const r = (tag_name: string, prerelease = tag_name.includes("-")) => ({ tag_name, draft: false, prerelease, assets: asset });
  assert.deepEqual(installable([r("v0.2.1"), r("v0.3.0-beta.2"), r("v0.3.0-beta.10"), r("v0.3.0"), r("nightly")]).map((x) => x.version),
    ["0.3.0", "0.3.0-beta.10", "0.3.0-beta.2", "0.2.1"]);
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 1; i < ordered.length; i++) assert.ok(compareVersions(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

test("a prerelease build finds a newer beta published before a maintenance release", async () => {
  const asked: string[] = [];
  const maintenance: Release = { tag: "v0.2.1", version: "0.2.1", prerelease: false };
  const newer: Release = { tag: "v0.3.0-beta.2", version: "0.3.0-beta.2", prerelease: true };
  const releases = installable([maintenance, newer].map((x) => ({ tag_name: x.tag, draft: false, prerelease: x.prerelease, assets: [{ name: "latest.json" }] })));
  const updates = new Updates(feed("0.3.0-beta.1", releases), async (tag) => { asked.push(tag); return { version: "0.3.0-beta.2", close: async () => {}, downloadAndInstall: async () => {} }; }, async () => {});
  await updates.check();
  assert.deepEqual(asked, ["v0.3.0-beta.2"]);
  assert.equal(updates.state.version, "0.3.0-beta.2");
  await new Updates(feed("0.3.0", releases), async (tag) => { asked.push(tag); return null; }, async () => {}).check();
  assert.equal(asked.length, 1);
});
