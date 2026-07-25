package online.xprei.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

// Non-secret provider config (id/kind/label/baseUrl/model) mirrors VS Code's
// xpreiIDE.providers setting shape 1:1 — see extensions/xpreiIDE-ai's
// ProviderConfig (@xprei/core). API keys are NEVER stored here; see
// XpreiSecrets (PasswordSafe).
data class ProviderConfigState(
    var id: String = "",
    var kind: String = "openai-compat", // "ollama" | "openai-compat"
    var label: String = "",
    var baseUrl: String = "",
    var model: String = "",
)

class XpreiSettingsData {
    var providers: MutableList<ProviderConfigState> = mutableListOf(
        ProviderConfigState(
            id = "ollama-local",
            kind = "ollama",
            label = "Ollama (local)",
            baseUrl = "http://localhost:11434",
        ),
    )
    var activeModel: String = ""
}

// Application-level (global) settings, matching VS Code's
// ConfigurationTarget.Global scope for providers/activeModel — these are user
// account settings, not per-project.
@State(name = "XpreiSettings", storages = [Storage("xpreiIDE.xml")])
@Service(Service.Level.APP)
class XpreiSettingsState : PersistentStateComponent<XpreiSettingsData> {
    private var data = XpreiSettingsData()

    override fun getState(): XpreiSettingsData = data

    override fun loadState(state: XpreiSettingsData) {
        XmlSerializerUtil.copyBean(state, data)
    }

    fun getConfigs(): List<ProviderConfigState> = data.providers

    fun addOrUpdate(cfg: ProviderConfigState) {
        data.providers.removeIf { it.id == cfg.id }
        data.providers.add(cfg)
    }

    fun remove(id: String) {
        data.providers.removeIf { it.id == id }
    }

    fun getActiveModel(): String = data.activeModel

    fun setActiveModel(pointer: String) {
        data.activeModel = pointer
    }

    companion object {
        fun getInstance(): XpreiSettingsState =
            ApplicationManager.getApplication().getService(XpreiSettingsState::class.java)
    }
}
