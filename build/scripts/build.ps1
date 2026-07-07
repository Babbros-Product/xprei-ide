# xpreiIDE branded-distro build driver (Windows).
#
# Produces a standalone, branded VS Code build with xpreiIDE-ai bundled as a
# built-in and Open VSX as the extension gallery. First run is long and multi-GB.
#
# Prereqs on PATH: git, node (20.x), python3, yarn, and VS Build Tools (C++
# "Desktop development with C++" workload) for native module compilation.
#
#   pwsh build/scripts/build.ps1                 # full build
#   pwsh build/scripts/build.ps1 -SkipClone      # reuse existing checkout
#   pwsh build/scripts/build.ps1 -StageOnly      # only restage the extension

param(
  [string]$VscodeTag = "1.90.2",
  [string]$Arch = "x64",
  [switch]$SkipClone,
  [switch]$StageOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vscodeDir = Join-Path $repoRoot "build\vscode"
$extDir = Join-Path $repoRoot "extensions\xpreiIDE-ai"
$outDir = Join-Path (Split-Path -Parent $vscodeDir) "VSCode-win32-$Arch"

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# 1. Source: clone Code-OSS at the pinned tag (or reuse).
if (-not $StageOnly) {
  if (-not $SkipClone) {
    if (Test-Path $vscodeDir) { Remove-Item -Recurse -Force $vscodeDir }
    Step "Cloning microsoft/vscode @ $VscodeTag"
    git clone --depth 1 --branch $VscodeTag https://github.com/microsoft/vscode.git $vscodeDir
  }

  # 2. Branding: merge our overrides into product.json.
  Step "Applying xpreiIDE branding"
  node (Join-Path $PSScriptRoot "patch-product.mjs") $vscodeDir

  # 3. Build the extension bundle. --prefix pins the working dir explicitly
  # instead of relying on Push-Location surviving into child processes.
  Step "Building xpreiIDE-ai extension"
  if (-not (Test-Path (Join-Path $extDir "node_modules"))) { npm install --prefix $extDir }
  npm run compile --prefix $extDir -- --minify

  # 4. Install VS Code build deps. --cwd is yarn's explicit-cwd pin (avoids
  # ambient-cwd reliance across processes). --ignore-scripts skips node-gyp
  # entirely: several built-in native modules (@vscode/policy-watcher,
  # @vscode/spdlog, @vscode/deviceid, @vscode/windows-ca-certs) fail to compile
  # under a nested Windows Job Object (seen when driven from a sandboxed agent
  # shell) with "AssignProcessToJobObject: (87)". They're runtime-only bindings
  # for enterprise policy/cert-store/logging/telemetry — unneeded to build or
  # run the editor, so skipping their install scripts is a safe workaround.
  Step "yarn install (VS Code root) — slow, scripts skipped"
  yarn --cwd $vscodeDir install --ignore-scripts

  # VS Code keeps a SEPARATE build/package.json for its own build tooling deps
  # (e.g. ternary-stream) — easy to miss, gulpfile.js fails without it.
  Step "yarn install (VS Code build/ subfolder)"
  yarn --cwd (Join-Path $vscodeDir "build") install --ignore-scripts

  # Every built-in extension also has its own package.json (including nested
  # */server subfolders for the language-feature extensions, plus extensions/
  # itself) — gulp's bundle-extensions-build step expects these pre-installed.
  Step "yarn install (built-in extensions, recursively)"
  Get-ChildItem (Join-Path $vscodeDir "extensions") -Recurse -Filter "package.json" |
    Where-Object { $_.FullName -notmatch "\\node_modules\\" } |
    ForEach-Object { yarn --cwd $_.Directory.FullName install --ignore-scripts }
  yarn --cwd (Join-Path $vscodeDir "extensions") install --ignore-scripts

  Step "gulp vscode-win32-$Arch — slow (~30-45 min, full recompile every run)"
  yarn --cwd $vscodeDir gulp "vscode-win32-$Arch"
}

# 5. Stage the extension into the built app as a built-in.
Step "Staging xpreiIDE-ai as a built-in"
if (-not (Test-Path $outDir)) { throw "Build output not found at $outDir. Run without -StageOnly first." }
node (Join-Path $PSScriptRoot "stage-extension.mjs") $outDir

Write-Host "`nDone. Portable app: $outDir" -ForegroundColor Green
Write-Host "Launch: $(Join-Path $outDir 'xpreiide.exe')" -ForegroundColor Green
Write-Host "Installer: run 'yarn gulp vscode-win32-$Arch-inno-setup' in $vscodeDir (needs Inno Setup)." -ForegroundColor Yellow
