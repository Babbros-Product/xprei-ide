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

  # 3. Build the extension bundle.
  Step "Building xpreiIDE-ai extension"
  Push-Location $extDir
  if (-not (Test-Path "node_modules")) { npm install }
  npm run compile -- --minify
  Pop-Location

  # 4. Install VS Code build deps + compile the product.
  Step "yarn install (VS Code) — slow, native deps"
  Push-Location $vscodeDir
  yarn
  Step "gulp vscode-win32-$Arch — slow"
  yarn gulp "vscode-win32-$Arch"
  Pop-Location
}

# 5. Stage the extension into the built app as a built-in.
Step "Staging xpreiIDE-ai as a built-in"
if (-not (Test-Path $outDir)) { throw "Build output not found at $outDir. Run without -StageOnly first." }
node (Join-Path $PSScriptRoot "stage-extension.mjs") $outDir

Write-Host "`nDone. Portable app: $outDir" -ForegroundColor Green
Write-Host "Launch: $(Join-Path $outDir 'xpreiide.exe')" -ForegroundColor Green
Write-Host "Installer: run 'yarn gulp vscode-win32-$Arch-inno-setup' in $vscodeDir (needs Inno Setup)." -ForegroundColor Yellow
