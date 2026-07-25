package online.xprei.ide.eclipse;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;

/**
 * Extracts the plugin's bundled resources (the shared {@code webview/}, and
 * the esbuild-bundled {@code sidecar.cjs} — both physically copied into this
 * bundle at build time by the child pom.xml's maven-resources-plugin
 * executions, listed in build.properties's bin.includes) to real files on
 * disk. SWT's {@code Browser.setUrl()} needs a real {@code file://} URL, and
 * {@code ProcessBuilder} needs a real path to spawn {@code node <path>}
 * against.
 */
public final class WebviewResources {
    private static final String[] WEBVIEW_FILES = {
        "index.html", "chat.js", "chat.css", "bridge.js", "theme-fallback.css", "icon.png", "icon.svg",
    };

    private static File extractedWebviewDir;
    private static File extractedSidecarPath;

    private WebviewResources() {}

    public static synchronized File extractWebviewDir() throws IOException {
        if (extractedWebviewDir != null) return extractedWebviewDir;
        File dir = Files.createTempDirectory("xprei-webview").toFile();
        for (String name : WEBVIEW_FILES) {
            try (InputStream in = WebviewResources.class.getClassLoader().getResourceAsStream("webview/" + name)) {
                if (in == null) continue; // best-effort; a missing icon shouldn't break chat
                copy(in, new File(dir, name));
            }
        }
        extractedWebviewDir = dir;
        return dir;
    }

    public static synchronized File extractSidecar() throws IOException {
        if (extractedSidecarPath != null) return extractedSidecarPath;
        File dir = Files.createTempDirectory("xprei-sidecar").toFile();
        File target = new File(dir, "sidecar.cjs");
        try (InputStream in = WebviewResources.class.getClassLoader().getResourceAsStream("sidecar.cjs")) {
            if (in == null) {
                throw new IOException(
                    "xpreiIDE: sidecar.cjs missing from plugin resources. Was `npm run build:sidecar -w "
                        + "@xprei/core` run before the Maven build? (The child pom's copy-sidecar execution "
                        + "should do this automatically.)");
            }
            copy(in, target);
        }
        extractedSidecarPath = target;
        return target;
    }

    private static void copy(InputStream in, File dest) throws IOException {
        try (OutputStream out = Files.newOutputStream(dest.toPath())) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }
}
