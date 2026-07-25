// xpreiIDE — JetBrains plugin. UNVERIFIED: written without a local JDK/Gradle
// to compile against (see extensions/intellij/README.md for the full caveat and
// what to check first). Grounded against the IntelliJ Platform Gradle Plugin
// 2.x docs (https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html)
// at the time of writing, not verified by an actual build.

plugins {
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "online.xprei.ide"
version = "0.0.1"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3")
        instrumentationTools()
    }
    implementation("com.google.code.gson:gson:2.11.0")
}

intellijPlatform {
    pluginConfiguration {
        id.set("online.xprei.ide")
        name.set("xpreiIDE")
        version.set(project.version.toString())
        vendor {
            name.set("Babbros")
            url.set("https://xprei.online")
            email.set("support@xprei.com")
        }
        ideaVersion {
            sinceBuild.set("233")
        }
    }
}

// The repo root, two levels up from extensions/intellij.
val repoRoot = rootDir.parentFile.parentFile
val webviewDir = File(repoRoot, "webview")
val coreDir = File(repoRoot, "packages/core")
val sidecarBundle = File(coreDir, "dist/sidecar.cjs")

sourceSets {
    main {
        // Bundle the shared, host-agnostic webview (chat.js/css, bridge.js,
        // theme-fallback.css, index.html, icons) directly from its single
        // source of truth at the repo root — same principle as the VS Code
        // extension's scripts/sync-webview.mjs, just via Gradle instead of a
        // Node copy step. Files land on the classpath at their bare names
        // (e.g. "chat.js", not "webview/chat.js").
        resources.srcDir(webviewDir)
        // The bundled sidecar (see packages/core/package.json's build:sidecar
        // script) lands on the classpath as "sidecar.cjs". Requires
        // `npm run build:sidecar -w @xprei/core` to have produced dist/ first
        // — the buildSidecar task below runs it automatically.
        resources.srcDir(File(coreDir, "dist"))
    }
}

// Runs the core's esbuild bundle step (npm run build:sidecar) so the plugin
// always ships a fresh sidecar.cjs. Requires Node.js on PATH at BUILD time
// (separate from the Node.js >= 18 requirement at RUNTIME on the end user's
// machine — see README.md).
val buildSidecar = tasks.register<Exec>("buildSidecar") {
    workingDir = repoRoot
    commandLine("npm", "run", "build:sidecar", "--workspace", "@xprei/core")
    inputs.dir(File(coreDir, "src"))
    outputs.file(sidecarBundle)
}

tasks.named("processResources") {
    dependsOn(buildSidecar)
}

tasks {
    wrapper {
        gradleVersion = "8.10"
    }
}
