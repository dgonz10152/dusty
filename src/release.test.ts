import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdateManifest } from "../scripts/update-manifest.mjs";

const names = ["Dusty_0.2.0_aarch64.app.tar.gz", "Dusty_0.2.0_x64.app.tar.gz", "Dusty_0.2.0_x64-setup.exe"];
const release = { draft: false, prerelease: false, tag_name: "v0.2.0", published_at: "2026-11-14T00:00:00Z", body: "Notes", assets: names.flatMap((name) => [name, `${name}.sig`]).map((name) => ({ name, size: 100, browser_download_url: `https://github.com/dgonz10152/dusty/releases/download/v0.2.0/${name}` })) };

test("manifest includes every platform with version-specific download URLs and signatures", () => {
  const manifest = createUpdateManifest(release, "0.2.0", () => "c2lnbmF0dXJl\n");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
  assert.match(manifest.platforms["windows-x86_64"].url, /v0\.2\.0.*setup\.exe$/);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "c2lnbmF0dXJl");
});

test("prereleases get their own feed", () => {
  const beta = names.map((n) => n.replace("0.2.0", "0.2.0-beta.1"));
  const assets = beta.flatMap((name) => [name, `${name}.sig`]).map((name) => ({ name, size: 100, browser_download_url: `https://github.com/dgonz10152/dusty/releases/download/v0.2.0-beta.1/${name}` }));
  const manifest = createUpdateManifest({ ...release, prerelease: true, tag_name: "v0.2.0-beta.1", assets }, "0.2.0-beta.1", () => "sig");
  assert.equal(manifest.version, "0.2.0-beta.1");
});

test("incomplete, unsigned, draft and mismatched releases never produce a feed", () => {
  for (const asset of release.assets) {
    assert.throws(() => createUpdateManifest({ ...release, assets: release.assets.filter((a) => a !== asset) }, "0.2.0", () => "sig"), /Missing signed update/);
  }
  assert.throws(() => createUpdateManifest({ ...release, draft: true }, "0.2.0", () => "sig"), /published release/);
  assert.throws(() => createUpdateManifest(release, "0.3.0", () => "sig"), /matching/);
  assert.throws(() => createUpdateManifest(release, "0.2.0", () => "not a signature"), /Invalid signature/);
});
