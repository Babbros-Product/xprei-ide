// Copies the shared webview (chat UI) into this extension's media/ dir before
// bundling. webview/ at the repo root is the single source of truth (also
// consumed by the future JetBrains/Eclipse plugins); media/ here is a generated
// copy, gitignored, so the packaged .vsix keeps its assets physically inside
// the extension dir (vsce refuses to package files reached via a path outside
// the extension root).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const extDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(extDir, "..", "..");
const src = join(repoRoot, "webview");
const dest = join(extDir, "media");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`synced ${src} -> ${dest}`);
