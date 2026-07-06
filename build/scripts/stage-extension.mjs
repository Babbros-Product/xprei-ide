// Stage the prebuilt xpreiIDE-ai extension into a built product as a built-in.
//
// Rather than fight VS Code's in-tree extension compile pipeline, we build the
// extension separately (esbuild → dist/extension.js) and copy the runtime files
// into the packaged app's extensions folder. Ships offline, no marketplace.
//
//   node build/scripts/stage-extension.mjs <path-to-built-app>
//
// <built-app> is the gulp output dir, e.g. ..\VSCode-win32-x64 (contains
// resources\app\extensions). We also accept that inner path directly.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const extDir = join(root, "extensions", "xpreiIDE-ai");
const appArg = process.argv[2];
if (!appArg) {
  console.error("usage: node stage-extension.mjs <built-app-dir>");
  process.exit(1);
}

// Locate the built-in extensions folder inside the packaged app.
const candidates = [
  join(appArg, "resources", "app", "extensions"), // win32 / linux
  join(appArg, "Contents", "Resources", "app", "extensions"), // darwin .app
  appArg, // caller passed the extensions dir directly
];
const extensionsRoot = candidates.find((p) => existsSync(p));
if (!extensionsRoot) {
  console.error(`Could not find an extensions folder under ${appArg}.`);
  process.exit(1);
}

if (!existsSync(join(extDir, "dist", "extension.js"))) {
  console.error("Build the extension first: (cd extensions/xpreiIDE-ai && npm run compile).");
  process.exit(1);
}

const target = join(extensionsRoot, "xpreiIDE-ai");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// Copy only runtime files — no src, tests, or node_modules.
cpSync(join(extDir, "dist"), join(target, "dist"), { recursive: true });
cpSync(join(extDir, "media"), join(target, "media"), { recursive: true });
if (existsSync(join(extDir, "README.md"))) cpSync(join(extDir, "README.md"), join(target, "README.md"));

// Trim the manifest: drop devDependencies and scripts so the built-in loads clean.
const pkg = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8"));
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

console.log(`Staged xpreiIDE-ai as a built-in at ${target}.`);
