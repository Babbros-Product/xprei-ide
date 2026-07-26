# xpreiIDE — Eclipse plugin

## ⚠️ Status: compiles and packages cleanly (verified 2026-07-26), NOT yet run in a live Eclipse instance

This was originally scaffolded on a machine with no JDK/Maven installed and
was unverified. It has since been built for real (JDK 21, Maven 3.9.16,
Tycho 5.0.2): `mvn clean verify` succeeds end-to-end — target platform
resolves, all 8 Java source files compile, the plugin jar is packaged. Two
real bugs were found and fixed in the process (see "Bugs found by the first
real build" below). What's still unverified: actually installing the built
jar into a live Eclipse instance and exercising its runtime behavior (SWT
`Browser`, `BrowserFunction`, Equinox Secure Storage, the sidecar process) —
the Java compiles, but no one has clicked through the chat view yet.

### What to do first

```bash
# from extensions/eclipse, with a JDK 17+ and Maven 3.9+ on PATH:
mvn -f online.xprei.ide.eclipse/pom.xml -N validate   # sanity-check the poms parse before a full build
mvn clean verify                                       # full Tycho build — resolves the target platform,
                                                         # compiles, packages
```

### Bugs found by the first real build (fixed)

1. **`target-platform-configuration`'s `<file>` path was wrong.** It's
   declared in the parent `pom.xml` (so it applies to the one child module),
   but Tycho resolves that path relative to the *executing* module's
   basedir — the child (`online.xprei.ide.eclipse/`), not the parent's.
   Since the `.target` file actually lives next to the parent pom, the path
   needed a `../` prefix (`pom.xml`).
2. **`Bundle-RequiredExecutionEnvironment: JavaSE-17` no longer satisfies
   the current Eclipse release train.** The `2026-06` release resolved from
   `.../releases/latest` includes `org.eclipse.help` requiring
   `osgi.ee=JavaSE;version=21` — bumped the manifest to `JavaSE-21`
   (`META-INF/MANIFEST.MF`) to match. This is exactly the "target platform
   resolution drift" risk this file used to warn about under `/releases/
   latest` — worth pinning to a dated release (e.g. `.../releases/2026-06`)
   for reproducibility now that a working baseline exists, rather than
   staying on a floating "latest" that can drift again.

Note: the `build-sidecar` exec-maven-plugin execution (item previously
flagged as a likely `npm`-on-Windows risk, same class of issue as the
JetBrains plugin's Gradle `Exec` task) did **not** need a fix —
`exec-maven-plugin` resolves `npm`/`npm.cmd` correctly on Windows without
extra shell-wrapping, unlike Gradle's `Exec` task.

### Remaining risk (not yet exercised)

1. **`META-INF/MANIFEST.MF`'s `Require-Bundle` list** — the exact set of
   bundles needed (`org.eclipse.ui`, `org.eclipse.core.runtime`,
   `org.eclipse.core.resources`, `org.eclipse.swt`,
   `org.eclipse.equinox.security`, `org.eclipse.equinox.preferences`) was
   reasoned from which packages the code imports, not confirmed against
   actually launching the plugin in an Eclipse instance. A missing bundle
   here fails as a runtime `ClassNotFoundException`, not a compile error —
   check this file first if the jar installs but the plugin won't
   activate/resolve.

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

Mirrors the IntelliJ plugin (see `extensions/JetBrains/README.md` for the shared
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
- **`XpreiSettings`** (reads/writes the shared `~/.xpreiide/config.yaml`
  via the hand-rolled `XpreiYamlLite` codec — see "Config storage" below)
  + **`XpreiSecrets`** (Equinox Secure Storage, `ISecurePreferences`) for
  config/keys.

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

## Config storage: shared ~/.xpreiide/config.yaml

`XpreiSettings`'s provider/active-model data no longer lives in
Eclipse's own `InstanceScope` preferences JSON blob — it reads/writes
`~/.xpreiide/config.yaml` directly, the same file the VS Code extension
and the IntelliJ plugin use (see
`docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md`).
`XpreiYamlLite.java` (new, in this package) is a hand-ported copy of
`packages/core/src/config/yamlLite.ts`'s parser/serializer — plain Java,
zero Eclipse/OSGi dependencies, same spirit as `MiniJson.java` above.
Like the rest of this plugin, **this change has not been compiled or
tested against a real JDK/Maven toolchain** — written and reviewed by
inspection only.

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
