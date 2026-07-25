package online.xprei.ide.eclipse;

import org.eclipse.equinox.security.storage.ISecurePreferences;
import org.eclipse.equinox.security.storage.SecurePreferencesFactory;
import org.eclipse.equinox.security.storage.StorageException;

/**
 * API keys in Equinox Secure Storage (OS-backed encryption), never in
 * {@link XpreiSettings} or plaintext — matches VS Code's SecretStorage and
 * the JetBrains plugin's PasswordSafe usage.
 */
public final class XpreiSecrets {
    private static final String NODE = "online.xprei.ide.eclipse/providers";

    private XpreiSecrets() {}

    private static ISecurePreferences node() {
        return SecurePreferencesFactory.getDefault().node(NODE);
    }

    public static String get(String providerId) {
        try {
            return node().get(providerId, null);
        } catch (StorageException e) {
            return null;
        }
    }

    public static void set(String providerId, String apiKey) {
        try {
            ISecurePreferences n = node();
            n.put(providerId, apiKey, true);
            n.flush();
        } catch (Exception e) {
            // Best-effort — not fatal to the current session.
        }
    }

    public static void remove(String providerId) {
        ISecurePreferences n = node();
        n.remove(providerId);
        try {
            n.flush();
        } catch (Exception e) {
            // Best-effort.
        }
    }
}
