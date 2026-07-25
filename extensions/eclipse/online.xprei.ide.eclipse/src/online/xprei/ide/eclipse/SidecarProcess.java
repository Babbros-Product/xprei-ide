package online.xprei.ide.eclipse;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/**
 * Launches and supervises the bundled xprei-core sidecar (the esbuild output
 * of packages/core/package.json's build:sidecar script) as a child process,
 * speaking line-delimited JSON over its stdin/stdout — the exact protocol
 * packages/core/src/server/harness.test.ts and sidecarBundle.test.ts verify
 * end-to-end. Requires Node.js &gt;= 18 on the user's PATH at runtime (same
 * MVP prerequisite as the IntelliJ plugin and the root README).
 */
public final class SidecarProcess {
    private final Consumer<String> onLine;
    private Process process;
    private Writer writer;

    public SidecarProcess(Consumer<String> onLine) {
        this.onLine = onLine;
    }

    public void start() throws IOException {
        File sidecarPath = WebviewResources.extractSidecar();
        ProcessBuilder builder = new ProcessBuilder("node", sidecarPath.getAbsolutePath());
        builder.redirectErrorStream(false);
        process = builder.start();
        writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8);

        Thread stdoutThread = new Thread(this::pumpStdout, "xprei-sidecar-stdout");
        stdoutThread.setDaemon(true);
        stdoutThread.start();

        Thread stderrThread = new Thread(this::pumpStderr, "xprei-sidecar-stderr");
        stderrThread.setDaemon(true);
        stderrThread.start();
    }

    private void pumpStdout() {
        try (BufferedReader reader =
                new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                onLine.accept(line);
            }
        } catch (IOException e) {
            // Process likely terminated (stop() closes the streams); nothing to do.
        }
    }

    private void pumpStderr() {
        try (BufferedReader reader =
                new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                System.err.println("xprei sidecar stderr: " + line);
            }
        } catch (IOException e) {
            // Ignore — same as pumpStdout.
        }
    }

    public synchronized void send(String json) {
        if (writer == null) {
            System.err.println("xprei sidecar: send() called before start()");
            return;
        }
        try {
            writer.write(json);
            writer.write("\n");
            writer.flush();
        } catch (IOException e) {
            System.err.println("xprei sidecar: failed to send: " + e.getMessage());
        }
    }

    public void stop() {
        if (process != null) {
            process.destroy();
            process = null;
        }
        writer = null;
    }
}
