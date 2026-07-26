package online.xprei.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter

// Launches and supervises the bundled xprei-core sidecar (the esbuild output
// of packages/core/package.json's build:sidecar script) as a child process,
// speaking line-delimited JSON over its stdin/stdout — the exact protocol
// packages/core/src/server/harness.test.ts and sidecarBundle.test.ts verify
// end-to-end. Requires Node.js >= 18 on the user's PATH at runtime (documented
// MVP prerequisite in the root README; bundling a Node runtime per-plugin is a
// later fast-follow — see docs/multi-ide-plan.md).
class SidecarProcess(private val onLine: (String) -> Unit) {
    private val log = Logger.getInstance(SidecarProcess::class.java)
    private var process: Process? = null
    private var writer: OutputStreamWriter? = null

    fun start() {
        val sidecarPath = WebviewResources.extractSidecar().absolutePath
        val process = ProcessBuilder("node", sidecarPath)
            .redirectErrorStream(false)
            .start()
        this.process = process
        this.writer = OutputStreamWriter(process.outputStream, Charsets.UTF_8)

        ApplicationManager.getApplication().executeOnPooledThread {
            BufferedReader(InputStreamReader(process.inputStream, Charsets.UTF_8)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    onLine(line!!)
                }
            }
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            BufferedReader(InputStreamReader(process.errorStream, Charsets.UTF_8)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    log.warn("xprei sidecar stderr: $line")
                }
            }
        }
    }

    @Synchronized
    fun send(json: String) {
        val w = writer
        if (w == null) {
            log.warn("xprei sidecar: send() called before start()")
            return
        }
        w.write(json)
        w.write("\n")
        w.flush()
    }

    fun stop() {
        process?.destroy()
        process = null
        writer = null
    }
}
