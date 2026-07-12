# xpreiIDE — branded distro build (P0)

Turns the `xpreiIDE-ai` extension into a **standalone, downloadable, branded
IDE** built on Code-OSS (the MIT-licensed VS Code source), VSCodium-style:

- own name / icons / data folder (`product.json` overrides)
- **Open VSX** as the extension gallery (MS marketplace is license-locked to MS builds)
- `xpreiIDE-ai` shipped **built-in**, works offline
- small, regenerable patch surface — no hand-maintained fork of core files

This directory is **build tooling only**. Nothing here is run automatically; you
kick off the (long, multi-GB) build when your toolchain is ready.

## Prerequisites

| Tool | Notes |
|------|-------|
| Git | clone the source |
| Node 20.x | VS Code build + our esbuild bundle |
| Python 3 | node-gyp for native modules |
| Yarn (classic) | VS Code uses yarn, not npm |
| **VS Build Tools (C++)** | Windows: "Desktop development with C++" workload. Linux: `build-essential`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev`. macOS: Xcode Command Line Tools |
| Inno Setup | *optional*, Windows installer (`.exe`) target only |

## Build it

**Windows**
```powershell
pwsh build/scripts/build.ps1                # full build → build/VSCode-win32-x64
pwsh build/scripts/build.ps1 -StageOnly     # re-copy the extension into an existing build
```

**macOS / Linux**
```bash
build/scripts/build.sh
```

Output is a portable app folder (e.g. `build/VSCode-win32-x64/xpreiide.exe`).
First build takes tens of minutes and downloads a lot; later builds are faster.

## What the scripts do

1. **Clone** `microsoft/vscode` at a pinned tag (`VscodeTag`, default `1.90.2` —
   keep in sync with the extension's `engines.vscode`).
2. **`patch-product.mjs`** merges `product.branding.json` into the checkout's
   `product.json` (name, win32/darwin identifiers, Open VSX gallery URLs). Shallow
   top-level merge — every other upstream field is preserved.
3. **Build the extension** (`npm run compile -- --minify`) → `dist/extension.js`.
4. **Build the product** (`yarn && yarn gulp vscode-<platform>`).
5. **`stage-extension.mjs`** copies the extension's runtime files (`dist`, `media`,
   trimmed `package.json`) into the built app's `resources/app/extensions/xpreiIDE-ai`.
   Post-build staging avoids fighting VS Code's in-tree extension compile pipeline.

## Configuring AI models

The build above ships an empty model list — nothing works until you point
xpreiIDE at a model. See **[MODELS.md](MODELS.md)** for the full guide
(gear icon in the chat panel, OpenAI/Gemini/Ollama base URLs, raw settings
JSON, and the Plan/Edit/Agent chat modes).

## Installer (optional)

```powershell
cd build/vscode
yarn gulp vscode-win32-x64-inno-setup     # needs Inno Setup on PATH
```

## Not done yet (deliberately deferred)

- **Icons.** `product.branding.json` names the icons but the actual `.ico`/`.icns`/
  PNG assets aren't in the repo — the build uses stock Code-OSS icons until we drop
  branded assets into the checkout's `resources/` during patch step.
- **Deep-UI patches.** Agent-first sidebar / inline ghost UI would be a `patches/`
  series applied after clone. Not needed for v1 — the extension already delivers
  chat, @context, Cmd-K, and the agent.
- **Code signing / auto-update.** Unsigned build; no update server wired.

## Legal

Code-OSS is MIT-licensed and **redistributable** under a different product name.
Do **not** ship Microsoft's official VS Code binaries or use the MS marketplace
from a fork — hence Open VSX.
