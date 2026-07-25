# xpreiIDE — Eclipse plugin

## ⚠️ Status: written, NOT compiled or run

Same situation as `extensions/intellij`: this was scaffolded on a machine with
**no JDK, no Maven** installed (confirmed: `java`, `javac`, `mvn` all absent
from PATH). Eclipse/Tycho builds are historically more finicky than Gradle
(target-platform resolution, P2 repository availability, Tycho version
drift), so treat this as an even-more-first-draft than the IntelliJ plugin —
grounded via documentation search, not compiled, not run.

### What to do first

```bash
# from extensions/eclipse, with a JDK 17+ and Maven 3.9+ on PATH:
mvn -f online.xprei.ide.eclipse/pom.xml -N validate   # sanity-check the poms parse before a full build
mvn clean verify                                       # full Tycho build — resolves the target platform,
                                                         # compiles, packages
```

The most likely failure classes, in order of likelihood:

1. **Target platform resolution.** `target-platform/target-platform.target`
   points at `https://download.eclipse.org/releases/latest` — a real, live p2
   repository, but the exact `org.eclipse.platform.feature.group` IU version
   Tycho resolves is whatever "latest" is *when you run this*, which drifts.
   If resolution fails or pulls something incompatible, pin to a dated
   release (e.g. `.../releases/2024-12`) instead — more reproducible, less
   convenient.
2. **Tycho version drift.** `5.0.2` (in `pom.xml`'s `tycho.version` property
   and `.mvn/extensions.xml`) was "current stable" per a web search at write
   time (dated 2026-01-24 in the search result) — not verified against an
   actual Maven run. Bump if resolution fails.
3. **The `build-sidecar` exec-maven-plugin execution** (child pom.xml) shells
   out to `npm run build:sidecar --workspace @xprei/core` from the repo root.
   If `npm` isn't on the PATH Maven sees, this fails — run
   `npm run build:sidecar -w @xprei/core` manually first to isolate that from
   any real Tycho/Java issue.
4. **`exec-maven-plugin` version `3.4.1`** and **`maven-resources-plugin`
   version `3.3.1`** — both very standard, widely-used plugins, lower risk
   than the Tycho-specific pieces, but still unverified here.
5. **`META-INF/MANIFEST.MF`'s `Require-Bundle` list** — the exact set of
   bundles needed (`org.eclipse.ui`, `org.eclipse.core.runtime`,
   `org.eclipse.core.resources`, `org.eclipse.swt`,
   `org.eclipse.equinox.security`, `org.eclipse.equinox.preferences`) was
   reasoned from which packages the code imports (`ISecurePreferences` needs
   `equinox.security`; `IEclipsePreferences`/`InstanceScope` needs
   `equinox.preferences`, which isn't guaranteed transitively re-exported by
   `core.runtime`), not confirmed against an actual OSGi resolution. A
   missing bundle here fails as a runtime `ClassNotFoundException` or a
   PDE/Tycho "cannot be resolved" error, not a compile error — if the Java
   compiles but the plugin won't launch/resolve, check this file first.

## The one piece you can verify with almost nothing

`src/online/xprei/ide/eclipse/MiniJson.java` has **zero Eclipse/OSGi
dependencies** — it's plain Java (java.util only). If you get access to
*any* JDK before a full Maven/Tycho toolchain, you can compile and
smoke-test just that file in isolation:

```bash
cd online.xprei.ide.eclipse/src
javac online/xprei/ide/eclipse/MiniJson.java
# then write a tiny throwaway Main.java that round-trips a few obj()/arr()
# values through stringify()/parse() and eyeball the output
```

This is the highest-value first check: every other class in this plugin
depends on `MiniJson` being correct, and it's the one piece with no
target-platform/Tycho dependency at all.

## Why MiniJson instead of Gson/org.json

Neither is guaranteed present in a bare `org.eclipse.platform.feature.group`
target platform without adding an Orbit p2 repository — one more unverified
moving part on top of an already-unverified Tycho build. `MiniJson` is a
small, self-contained, independently-testable JSON codec instead, scoped
exactly to the object/array/string/number/boolean/null shapes this plugin
actually sends and receives.

## Architecture

Mirrors the IntelliJ plugin (see `extensions/intellij/README.md` for the shared
background) with Eclipse's own platform APIs:

- **`XpreiChatView`** (`ViewPart`) hosts an SWT `Browser` loading the same
  `webview/index.html` the VS Code extension and IntelliJ plugin use.
  JS→Java via a `BrowserFunction`; Java→JS via `Browser.execute(...)`,
  always marshaled onto the SWT UI thread with `Display.asyncExec` (sidecar
  events arrive on a background stdout-reader thread).
- **`XpreiHostBridge`** — the same webview↔sidecar-JSON-RPC translation
  layer as the IntelliJ plugin's `XpreiHostBridge.kt`, ported to Java +
  `MiniJson` instead of Kotlin + Gson. Kept in sync manually — there's no
  module shared between the two JVM plugins.
- **`SidecarProcess`** + **`WebviewResources`** — spawn the bundled
  `sidecar.cjs`, extract webview assets from plugin resources to temp files.
  Same Node.js ≥ 18-on-PATH runtime prerequisite as the IntelliJ plugin.
- **`XpreiSettings`** (`InstanceScope` preferences, JSON-blob serialized —
  Eclipse preferences only store flat values) + **`XpreiSecrets`**
  (Equinox Secure Storage, `ISecurePreferences`) for config/keys.

### MVP simplifications (same list as IntelliJ, plus one Eclipse-specific one)

- Single in-memory chat session; `insertAtCursor`/`applyEdit` no-ops; no
  revert-last-run menu entry yet (sidecar RPC exists, tested).
- **Workspace root resolution is Eclipse-specific and simplified.** An
  Eclipse workspace can hold multiple projects, unlike VS Code's single
  workspace folder or JetBrains' `project.basePath`. `XpreiChatView` uses the
  first *open* project's location, falling back to the workspace root
  directory if none — a real multi-project workspace isn't fully modeled.
  Likewise, `agent.edit`'s workspace refresh (`refreshWorkspaceFile`) just
  refreshes every open project rather than tracking which project owns the
  written path (cheap for typical project counts, simplest correct MVP
  behavior — not necessarily the most efficient one).

## What IS verifiable already (do this before touching Java further)

```bash
# from the repo root:
npm test -w @xprei/core                    # 92 tests, includes the sidecar
                                             # protocol this plugin depends on
npm run build:sidecar -w @xprei/core        # produces dist/sidecar.cjs directly,
                                             # isolates that step from Maven
```

If either fails, fix it in `packages/core` first — this plugin can't be more
correct than the sidecar it drives.
