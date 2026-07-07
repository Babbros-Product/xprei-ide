#!/usr/bin/env bash
# xpreiIDE branded-distro build driver (macOS/Linux). See build.ps1 for Windows.
#
# Prereqs: git, node 20.x, python3, yarn, and platform build tools
# (build-essential + libx11-dev etc. on Linux; Xcode CLT on macOS).
#
#   build/scripts/build.sh                 # full build
#   VSCODE_TAG=1.90.2 build/scripts/build.sh
set -euo pipefail

VSCODE_TAG="${VSCODE_TAG:-1.90.2}"
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
vscode_dir="$repo_root/build/vscode"
ext_dir="$repo_root/extensions/xpreiIDE-ai"

case "$(uname -s)" in
  Darwin) target="vscode-darwin-$(uname -m | sed 's/x86_64/x64/;s/arm64/arm64/')"; out="$repo_root/build/VSCode-darwin" ;;
  Linux)  target="vscode-linux-x64"; out="$repo_root/build/VSCode-linux-x64" ;;
  *) echo "Unsupported OS"; exit 1 ;;
esac

step() { printf '\n=== %s ===\n' "$1"; }

step "Cloning microsoft/vscode @ $VSCODE_TAG"
rm -rf "$vscode_dir"
git clone --depth 1 --branch "$VSCODE_TAG" https://github.com/microsoft/vscode.git "$vscode_dir"

step "Applying xpreiIDE branding"
node "$repo_root/build/scripts/patch-product.mjs" "$vscode_dir"

step "Building xpreiIDE-ai extension"
[ -d "$ext_dir/node_modules" ] || npm install --prefix "$ext_dir"
npm run compile --prefix "$ext_dir" -- --minify

step "yarn install (VS Code root) — slow, native deps"
yarn --cwd "$vscode_dir"

# VS Code keeps a SEPARATE build/package.json for its own build tooling deps
# (e.g. ternary-stream) — gulpfile.js fails without it.
step "yarn install (VS Code build/ subfolder)"
yarn --cwd "$vscode_dir/build"

# Every built-in extension has its own package.json too (including nested
# */server subfolders for the language-feature extensions, plus extensions/
# itself) — gulp's bundle-extensions-build step expects these pre-installed.
step "yarn install (built-in extensions, recursively)"
find "$vscode_dir/extensions" -name package.json -not -path "*/node_modules/*" \
  -exec dirname {} \; | while read -r d; do yarn --cwd "$d"; done
yarn --cwd "$vscode_dir/extensions"

step "gulp $target — slow (~30-45 min, full recompile every run)"
yarn --cwd "$vscode_dir" gulp "$target"

step "Staging xpreiIDE-ai as a built-in"
node "$repo_root/build/scripts/stage-extension.mjs" "$out"

echo
echo "Done. App: $out"
