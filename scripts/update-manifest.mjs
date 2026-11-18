import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Publish one complete feed per release (stable or prerelease) only after all three signed platform builds succeed. */
export function createUpdateManifest(release, version, readSignature) {
  if (release.draft || release.tag_name.replace(/^v/, "") !== version) {
    throw new Error("The update feed requires a published release matching the app version.");
  }
  const names = {
    "darwin-aarch64": `Dusty_${version}_aarch64.app.tar.gz`,
    "darwin-x86_64": `Dusty_${version}_x64.app.tar.gz`,
    "windows-x86_64": `Dusty_${version}_x64-setup.exe`,
  };
  const platforms = {};
  for (const [platform, name] of Object.entries(names)) {
    const asset = release.assets.find((a) => a.name === name);
    const signatureAsset = release.assets.find((a) => a.name === `${name}.sig`);
    if (!asset || !signatureAsset || !asset.size || !signatureAsset.size) throw new Error(`Missing signed update for ${platform}`);
    const url = new URL(asset.browser_download_url);
    if (url.protocol !== "https:") throw new Error(`Invalid download URL for ${platform}`);
    const signature = readSignature(signatureAsset.name).trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error(`Invalid signature for ${platform}`);
    platforms[platform] = { url: url.href, signature };
  }
  return { version, notes: release.body ?? "", pub_date: release.published_at, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [releasePath, signatureDir, outputPath] = process.argv.slice(2);
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (pkg.version !== config.version || cargo !== config.version) throw new Error("App versions must match in all three manifests.");
  const manifest = createUpdateManifest(JSON.parse(readFileSync(releasePath, "utf8")), config.version,
    (name) => readFileSync(join(signatureDir, name), "utf8"));
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
