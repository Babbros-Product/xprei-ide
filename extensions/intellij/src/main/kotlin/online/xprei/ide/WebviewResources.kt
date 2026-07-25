package online.xprei.ide

import java.io.File
import java.nio.file.Files

// Extracts the plugin's bundled classpath resources (the shared webview/, and
// the esbuild-bundled sidecar.cjs — both wired onto the classpath by
// build.gradle.kts's sourceSets.main.resources.srcDir) to real files on disk.
// JBCefBrowser.loadURL() needs an actual file:// URL (a jar:// URL won't
// resolve the webview's own relative asset links), and ProcessBuilder needs a
// real path to spawn `node <path>` against.
object WebviewResources {
    private val WEBVIEW_FILES = listOf(
        "index.html", "chat.js", "chat.css", "bridge.js", "theme-fallback.css",
        "icon.png", "icon.svg",
    )

    @Volatile
    private var extractedWebviewDir: File? = null

    @Volatile
    private var extractedSidecarPath: File? = null

    @Synchronized
    fun extractWebviewDir(): File {
        extractedWebviewDir?.let { return it }
        val dir = Files.createTempDirectory("xprei-webview").toFile()
        for (name in WEBVIEW_FILES) {
            val stream = javaClass.classLoader.getResourceAsStream(name) ?: continue
            stream.use { input -> File(dir, name).outputStream().use { input.copyTo(it) } }
        }
        extractedWebviewDir = dir
        return dir
    }

    @Synchronized
    fun extractSidecar(): File {
        extractedSidecarPath?.let { return it }
        val dir = Files.createTempDirectory("xprei-sidecar").toFile()
        val target = File(dir, "sidecar.cjs")
        val stream = javaClass.classLoader.getResourceAsStream("sidecar.cjs")
            ?: error(
                "xpreiIDE: sidecar.cjs missing from plugin resources. " +
                    "Was `npm run build:sidecar -w @xprei/core` run before the Gradle build? " +
                    "(build.gradle.kts's buildSidecar task should do this automatically.)",
            )
        stream.use { input -> target.outputStream().use { input.copyTo(it) } }
        extractedSidecarPath = target
        return target
    }
}
