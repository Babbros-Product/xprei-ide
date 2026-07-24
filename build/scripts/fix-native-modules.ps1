# Compile native (node-gyp) modules that yarn's --ignore-scripts skipped during
# the main VS Code install, then repack node_modules.asar to include them.
#
# Background: the main build (build.ps1) installs VS Code's dependencies with
# --ignore-scripts so gulp always completes even in constrained/sandboxed shells
# (node-gyp can fail there — see notes below). That leaves native modules like
# the integrated terminal (node-pty) and Windows policy/cert/logging bindings
# uncompiled, and the app crashes on launch needing them. This script compiles
# them for real and folds the result into an already-built app.
#
#   pwsh build/scripts/fix-native-modules.ps1 -BuiltApp build\VSCode-win32-x64
#
# Two environment issues this works around (found by direct diagnosis on this
# project, not general Windows behavior — but harmless to always apply):
#   1. node-gyp locates Python via the "py" launcher, which creates its own
#      Windows Job Object to track the interpreter. If the calling process is
#      itself inside a restrictive job (e.g. driven from a sandboxed agent
#      shell), that nested creation fails with "AssignProcessToJobObject: (87)
#      The parameter is incorrect." Setting $env:PYTHON to a real python.exe
#      (bypassing py.exe entirely) avoids the nested job creation altogether.
#   2. Some packages' gyp files (winpty, a node-pty dependency) invoke a bare
#      batch file name relying on cmd.exe's implicit current-directory search.
#      If $env:NoDefaultCurrentDirectoryInExePath is set to any value (as it
#      was in this environment — inherited, not something we set), that search
#      is disabled and the batch file "isn't recognized" even though it's
#      right there. Clearing the env var for this process fixes it.

param(
  [string]$BuiltApp = "build\VSCode-win32-x64",
  [string]$Python
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$vscodeDir = Join-Path $repoRoot "build\vscode"
$nodeModules = Join-Path $vscodeDir "node_modules"
$appDir = if ([System.IO.Path]::IsPathRooted($BuiltApp)) { $BuiltApp } else { Join-Path $repoRoot $BuiltApp }
$appResources = Join-Path $appDir "resources\app"

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# --- Environment fixes (see header) ---
if (-not $Python) {
  $pyList = & py -0p 2>$null
  $match = $pyList | Select-String -Pattern '^\s*-V:\S+\s+(.+)$' | Select-Object -First 1
  if ($match) { $Python = $match.Matches[0].Groups[1].Value.Trim() }
}
if (-not $Python -or -not (Test-Path $Python)) {
  throw "Could not auto-detect a python.exe. Pass -Python <path-to-python.exe> explicitly."
}
$env:PYTHON = $Python
Remove-Item Env:\NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
Write-Host "Using PYTHON=$Python"

$nodeGyp = Get-ChildItem -Path (Join-Path $env:APPDATA "..\Local\nvm") -Recurse -Filter "node-gyp.js" -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $nodeGyp) {
  $npmRoot = & npm root -g
  $nodeGyp = Get-ChildItem -Path $npmRoot -Recurse -Filter "node-gyp.js" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $nodeGyp) { throw "Could not locate node-gyp.js. Ensure npm/node-gyp is installed." }

# --- Compile every native module with a binding.gyp ---
Step "Compiling native modules (node-gyp rebuild)"
$failed = @()
Get-ChildItem -Path $nodeModules -Recurse -Filter "binding.gyp" -Depth 3 -ErrorAction SilentlyContinue |
  ForEach-Object {
    $pkgDir = $_.Directory.FullName
    $name = $pkgDir.Substring($nodeModules.Length + 1)
    Write-Host "  $name"
    # cmd /c "cd /d ... && ..." pins the working dir explicitly — avoids relying
    # on Push-Location surviving into a child node-gyp process (unreliable when
    # this script itself runs nested inside another script/process).
    cmd /c "cd /d `"$pkgDir`" && node `"$($nodeGyp.FullName)`" rebuild" *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "    FAILED (leaving uncompiled — check if it's actually needed at runtime)" -ForegroundColor Yellow
      $failed += $name
    }
  }
if ($failed.Count -gt 0) {
  Write-Host "`nCould not compile: $($failed -join ', ')" -ForegroundColor Yellow
  Write-Host "(known: 'kerberos' fails here — bundled node-addon-api is incompatible with" -ForegroundColor Yellow
  Write-Host " current Node's N-API; it's not required for core editor startup.)" -ForegroundColor Yellow
}

# --- Repack node_modules.asar with the same unpack globs VS Code's own build uses ---
Step "Repacking node_modules.asar"
$unpackGlob = "**/@(*.node|*.wasm|@vscode/ripgrep/bin/*|node-pty/build/Release/*|" +
  "node-pty/lib/worker/conoutSocketWorker.js|node-pty/lib/shared/conout.js|@vscode/vsce-sign/bin/*)"
$asarBin = Join-Path $nodeModules "asar\bin\asar.js"
$work = Join-Path $repoRoot "build\asar-work"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work | Out-Null

node $asarBin extract (Join-Path $appResources "node_modules.asar") (Join-Path $work "node_modules")
node $asarBin pack (Join-Path $work "node_modules") (Join-Path $work "node_modules.asar") --unpack $unpackGlob

# The plain CLI doesn't auto-write the sibling .unpacked mirror — build it
# ourselves from the same source tree using the identical glob semantics.
$unpackedDir = Join-Path $work "node_modules.asar.unpacked"
New-Item -ItemType Directory -Path $unpackedDir | Out-Null
$srcTree = Join-Path $work "node_modules"
Get-ChildItem -Path $srcTree -Recurse -File | Where-Object {
  $rel = $_.FullName.Substring($srcTree.Length + 1) -replace '\\', '/'
  $rel -like "*.node" -or $rel -like "*.wasm" -or
  $rel -like "*/@vscode/ripgrep/bin/*" -or
  $rel -like "*/node-pty/build/Release/*" -or
  $rel -like "*/node-pty/lib/worker/conoutSocketWorker.js" -or
  $rel -like "*/node-pty/lib/shared/conout.js" -or
  $rel -like "*/@vscode/vsce-sign/bin/*"
} | ForEach-Object {
  $rel = $_.FullName.Substring($srcTree.Length + 1)
  $dest = Join-Path $unpackedDir $rel
  New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
  Copy-Item $_.FullName $dest
}

# --- Swap into the built app ---
Step "Installing repacked asar into $BuiltApp"
$target = Join-Path $appResources "node_modules.asar"
if (Test-Path $target) {
  Move-Item $target "$target.bak" -Force
}
Remove-Item -Recurse -Force (Join-Path $appResources "node_modules.asar.unpacked") -ErrorAction SilentlyContinue
Copy-Item (Join-Path $work "node_modules.asar") $target
Copy-Item -Recurse (Join-Path $work "node_modules.asar.unpacked") (Join-Path $appResources "node_modules.asar.unpacked")

Write-Host "`nDone. Native modules compiled and folded into $BuiltApp." -ForegroundColor Green
