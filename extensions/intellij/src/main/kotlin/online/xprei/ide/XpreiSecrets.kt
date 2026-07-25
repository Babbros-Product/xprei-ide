package online.xprei.ide

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe

// API keys in the OS-backed PasswordSafe, never in XpreiSettingsState or
// plaintext — matches VS Code's SecretStorage usage in providers/registry.ts.
object XpreiSecrets {
    private fun attributes(providerId: String): CredentialAttributes =
        CredentialAttributes(generateServiceName("xpreiIDE", providerId))

    fun get(providerId: String): String? =
        PasswordSafe.instance.getPassword(attributes(providerId))

    fun set(providerId: String, apiKey: String) {
        PasswordSafe.instance.set(attributes(providerId), Credentials(providerId, apiKey))
    }

    fun remove(providerId: String) {
        PasswordSafe.instance.set(attributes(providerId), null)
    }
}
