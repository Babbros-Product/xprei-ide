package online.xprei.ide.eclipse;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static online.xprei.ide.eclipse.MiniJson.asStr;
import static online.xprei.ide.eclipse.MiniJson.obj;

/**
 * Non-secret provider config, persisted in the shared
 * ~/.xpreiide/config.yaml — the same file VS Code and the IntelliJ
 * plugin read/write (see
 * docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md).
 * Storage moved off Eclipse's own InstanceScope preferences JSON blob
 * so provider/model config is shared across every host. API keys are
 * NEVER stored here — see {@link XpreiSecrets} (Equinox Secure
 * Storage). NOT compiled or tested in this environment (no local Maven
 * available) — verify against a real Eclipse workspace before relying
 * on it.
 */
public final class XpreiSettings {
    private static final String KEY_PROVIDERS = "providers";
    private static final String KEY_ACTIVE_MODEL = "activeModel";

    private XpreiSettings() {}

    private static File configFile() {
        return Paths.get(System.getProperty("user.home"), ".xpreiide", "config.yaml").toFile();
    }

    private static Map<String, Object> readRaw() {
        File file = configFile();
        if (!file.exists()) return new LinkedHashMap<>();
        try {
            String content = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            return XpreiYamlLite.parse(content);
        } catch (IOException e) {
            return new LinkedHashMap<>();
        }
    }

    private static void writeRaw(Map<String, Object> raw) {
        File file = configFile();
        file.getParentFile().mkdirs();
        try {
            Files.write(file.toPath(), XpreiYamlLite.stringify(raw).getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // Best-effort persistence — matches this class's prior
            // BackingStoreException handling: the caller already has the
            // in-memory value it intended to persist, even if the
            // on-disk write failed.
        }
    }

    /** Each entry: {id, kind, label, baseUrl, model}. */
    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> getProviders() {
        Map<String, Object> raw = readRaw();
        Object providersRaw = raw.get(KEY_PROVIDERS);
        if (!(providersRaw instanceof List)) {
            List<Map<String, Object>> defaults = new ArrayList<>();
            defaults.add(obj(
                "id", "ollama-local",
                "kind", "ollama",
                "label", "Ollama (local)",
                "baseUrl", "http://localhost:11434",
                "model", ""));
            return defaults;
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : (List<Object>) providersRaw) {
            if (o instanceof Map) out.add((Map<String, Object>) o);
        }
        return out;
    }

    public static void setProviders(List<Map<String, Object>> providers) {
        Map<String, Object> raw = readRaw();
        raw.put(KEY_PROVIDERS, providers);
        writeRaw(raw);
    }

    public static void addOrUpdate(Map<String, Object> cfg) {
        List<Map<String, Object>> current = getProviders();
        String id = asStr(cfg.get("id"), "");
        current.removeIf(p -> id.equals(asStr(p.get("id"), "")));
        current.add(cfg);
        setProviders(current);
    }

    public static void remove(String id) {
        List<Map<String, Object>> current = getProviders();
        current.removeIf(p -> id.equals(asStr(p.get("id"), "")));
        setProviders(current);
    }

    public static Set<String> getProviderIds() {
        Set<String> ids = new HashSet<>();
        for (Map<String, Object> p : getProviders()) ids.add(asStr(p.get("id"), ""));
        return ids;
    }

    public static String getActiveModel() {
        Object v = readRaw().get(KEY_ACTIVE_MODEL);
        return v instanceof String ? (String) v : "";
    }

    public static void setActiveModel(String pointer) {
        Map<String, Object> raw = readRaw();
        raw.put(KEY_ACTIVE_MODEL, pointer);
        writeRaw(raw);
    }
}
