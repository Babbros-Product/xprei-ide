package online.xprei.ide.eclipse;

import org.eclipse.core.runtime.preferences.IEclipsePreferences;
import org.eclipse.core.runtime.preferences.InstanceScope;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.prefs.BackingStoreException;

import static online.xprei.ide.eclipse.MiniJson.asArr;
import static online.xprei.ide.eclipse.MiniJson.asObj;
import static online.xprei.ide.eclipse.MiniJson.asStr;
import static online.xprei.ide.eclipse.MiniJson.obj;

/**
 * Non-secret provider config, persisted as a JSON blob in Eclipse's
 * InstanceScope preferences (application/workspace-global — matches VS
 * Code's ConfigurationTarget.Global and the JetBrains plugin's app-level
 * PersistentStateComponent). API keys are NEVER stored here — see
 * {@link XpreiSecrets} (Equinox Secure Storage). Preferences only store
 * flat string/int/bool values, not structured lists, hence the JSON-blob
 * serialization via {@link MiniJson}.
 */
public final class XpreiSettings {
    private static final String NODE = "online.xprei.ide.eclipse";
    private static final String KEY_PROVIDERS = "providers";
    private static final String KEY_ACTIVE_MODEL = "activeModel";

    private XpreiSettings() {}

    private static IEclipsePreferences node() {
        return InstanceScope.INSTANCE.getNode(NODE);
    }

    /** Each entry: {id, kind, label, baseUrl, model}. */
    public static List<Map<String, Object>> getProviders() {
        String raw = node().get(KEY_PROVIDERS, "");
        if (raw.isEmpty()) {
            List<Map<String, Object>> defaults = new ArrayList<>();
            defaults.add(obj(
                "id", "ollama-local",
                "kind", "ollama",
                "label", "Ollama (local)",
                "baseUrl", "http://localhost:11434",
                "model", ""));
            return defaults;
        }
        List<Object> parsed = asArr(MiniJson.parse(raw));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : parsed) out.add(asObj(o));
        return out;
    }

    public static void setProviders(List<Map<String, Object>> providers) {
        node().put(KEY_PROVIDERS, MiniJson.stringify(providers));
        flush();
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
        return node().get(KEY_ACTIVE_MODEL, "");
    }

    public static void setActiveModel(String pointer) {
        node().put(KEY_ACTIVE_MODEL, pointer);
        flush();
    }

    private static void flush() {
        try {
            node().flush();
        } catch (BackingStoreException e) {
            // Best-effort persistence — the in-memory node value (already
            // updated by put()) is still correct for the rest of this
            // session even if the on-disk write failed.
        }
    }
}
