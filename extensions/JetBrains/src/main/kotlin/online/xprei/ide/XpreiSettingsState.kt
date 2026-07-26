package online.xprei.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil
import java.io.File
import java.nio.file.Paths

// Non-secret provider config (id/kind/label/baseUrl/model) mirrors VS Code's
// ProviderConfig (@xprei/core) 1:1. API keys are NEVER stored here; see
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

// Hand-rolled restricted-subset YAML parser/serializer, ported by hand
// from packages/core/src/config/yamlLite.ts — same supported grammar
// (block mappings, "- " sequences, simple quoted/unquoted scalars, "#"
// comments), same NOT-supported list (no anchors, no flow collections,
// no multi-document files). NOT compiled or tested in this environment
// (no local JDK/Gradle available) — verify against a real IntelliJ
// sandbox before relying on it. See
// docs/superpowers/specs/2026-07-26-phase6-shared-config-design.md.
object XpreiYamlLite {
    private data class Line(val indent: Int, val text: String)

    private fun tokenize(content: String): List<Line> {
        val lines = mutableListOf<Line>()
        for (rawLine in content.split(Regex("\r?\n"))) {
            var line = rawLine
            var inSingle = false
            var inDouble = false
            var cut = line.length
            for (i in line.indices) {
                val ch = line[i]
                if (ch == '\'' && !inDouble) inSingle = !inSingle
                else if (ch == '"' && !inSingle) inDouble = !inDouble
                else if (ch == '#' && !inSingle && !inDouble) { cut = i; break }
            }
            line = line.substring(0, cut).trimEnd()
            if (line.isBlank()) continue
            val indent = line.length - line.trimStart().length
            lines.add(Line(indent, line.trim()))
        }
        return lines
    }

    private fun findKeyColon(text: String): Int {
        var inSingle = false
        var inDouble = false
        for (k in text.indices) {
            val ch = text[k]
            if (ch == '\'' && !inDouble) inSingle = !inSingle
            else if (ch == '"' && !inSingle) inDouble = !inDouble
            else if (ch == ':' && !inSingle && !inDouble) {
                if (k == text.length - 1 || text[k + 1] == ' ') return k
            }
        }
        return -1
    }

    private fun stripQuotes(s: String): String {
        if (s.length >= 2 && ((s.first() == '"' && s.last() == '"') || (s.first() == '\'' && s.last() == '\''))) {
            return s.substring(1, s.length - 1)
        }
        return s
    }

    private fun parseScalar(raw: String): Any? {
        val s = raw.trim()
        if (s.isEmpty() || s == "~" || s == "null") return null
        if (s == "true") return true
        if (s == "false") return false
        if (Regex("^-?\\d+(\\.\\d+)?$").matches(s)) return s.toDouble()
        return stripQuotes(s)
    }

    // Returns Map<String, Any?> where Any? is String/Double/Boolean/null/
    // List<Any?>/Map<String, Any?> — the same dynamic shape as the
    // TypeScript YamlValue union, since Kotlin has no equivalent sealed
    // union readily available without extra ceremony this port doesn't
    // need.
    fun parse(content: String): Map<String, Any?> {
        val lines = tokenize(content)
        if (lines.isEmpty()) return emptyMap()
        @Suppress("UNCHECKED_CAST")
        return parseMapping(lines, 0, lines[0].indent).first as Map<String, Any?>
    }

    private fun parseBlock(lines: List<Line>, start: Int): Pair<Any?, Int> {
        val indent = lines[start].indent
        return if (lines[start].text.startsWith("- ") || lines[start].text == "-") {
            parseSequence(lines, start, indent)
        } else {
            parseMapping(lines, start, indent)
        }
    }

    private fun parseSequence(lines: List<Line>, start: Int, indent: Int): Pair<Any?, Int> {
        val out = mutableListOf<Any?>()
        var i = start
        while (i < lines.size && lines[i].indent == indent &&
            (lines[i].text.startsWith("- ") || lines[i].text == "-")) {
            val itemText = if (lines[i].text == "-") "" else lines[i].text.substring(2)
            val childIndent = indent + 2
            if (itemText.isEmpty()) {
                if (i + 1 < lines.size && lines[i + 1].indent > indent) {
                    val (v, next) = parseBlock(lines, i + 1)
                    out.add(v); i = next
                } else { out.add(null); i++ }
                continue
            }
            val colonIdx = findKeyColon(itemText)
            if (colonIdx == -1) { out.add(parseScalar(itemText)); i++; continue }
            val synthetic = mutableListOf(Line(childIndent, itemText))
            var j = i + 1
            while (j < lines.size && lines[j].indent >= childIndent) { synthetic.add(lines[j]); j++ }
            val (mapVal, _) = parseMapping(synthetic, 0, childIndent)
            out.add(mapVal); i = j
        }
        return Pair(out, i)
    }

    private fun parseMapping(lines: List<Line>, start: Int, indent: Int): Pair<Any?, Int> {
        val out = linkedMapOf<String, Any?>()
        var i = start
        while (i < lines.size && lines[i].indent == indent) {
            val text = lines[i].text
            val colonIdx = findKeyColon(text)
            if (colonIdx == -1) break
            val key = stripQuotes(text.substring(0, colonIdx).trim())
            val rest = text.substring(colonIdx + 1).trim()
            if (rest.isEmpty()) {
                if (i + 1 < lines.size && lines[i + 1].indent > indent) {
                    val (v, next) = parseBlock(lines, i + 1)
                    out[key] = v; i = next
                } else { out[key] = null; i++ }
            } else {
                out[key] = parseScalar(rest); i++
            }
        }
        return Pair(out, i)
    }

    private fun needsQuoting(s: String): Boolean {
        if (s.isEmpty()) return true
        if (Regex("^-?\\d+(\\.\\d+)?$").matches(s)) return true
        if (s == "true" || s == "false" || s == "null" || s == "~") return true
        if (s.first().isWhitespace() || s.last().isWhitespace()) return true
        if (s.contains(": ") || s.startsWith("#") || s.startsWith("- ") ||
            s.startsWith("'") || s.startsWith("\"")) return true
        return false
    }

    private fun quoteScalar(s: String): String =
        "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private fun formatScalar(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> v.toString()
        is Double -> if (v == v.toLong().toDouble()) v.toLong().toString() else v.toString()
        is String -> if (needsQuoting(v)) quoteScalar(v) else v
        else -> v.toString()
    }

    fun stringify(value: Map<String, Any?>): String {
        val lines = mutableListOf<String>()
        stringifyValue(value, 0, lines)
        return lines.joinToString("\n") + "\n"
    }

    @Suppress("UNCHECKED_CAST")
    private fun stringifyValue(value: Any?, indent: Int, lines: MutableList<String>) {
        val pad = " ".repeat(indent)
        when (value) {
            is List<*> -> {
                for (item in value) {
                    when {
                        item is Map<*, *> -> {
                            val entries = (item as Map<String, Any?>).entries.toList()
                            if (entries.isEmpty()) { lines.add("$pad- {}"); continue }
                            val (firstKey, firstVal) = entries[0]
                            if (firstVal is Map<*, *> || firstVal is List<*>) {
                                lines.add("$pad- $firstKey:")
                                stringifyValue(firstVal, indent + 4, lines)
                            } else {
                                lines.add("$pad- $firstKey: ${formatScalar(firstVal)}")
                            }
                            for ((k, v) in entries.drop(1)) {
                                if (v is Map<*, *> || v is List<*>) {
                                    lines.add("$pad  $k:")
                                    stringifyValue(v, indent + 4, lines)
                                } else {
                                    lines.add("$pad  $k: ${formatScalar(v)}")
                                }
                            }
                        }
                        item is List<*> -> { lines.add("$pad-"); stringifyValue(item, indent + 2, lines) }
                        else -> lines.add("$pad- ${formatScalar(item)}")
                    }
                }
            }
            is Map<*, *> -> {
                for ((key, v) in (value as Map<String, Any?>)) {
                    if (v is Map<*, *> || v is List<*>) {
                        lines.add("$pad$key:")
                        stringifyValue(v, indent + 2, lines)
                    } else {
                        lines.add("$pad$key: ${formatScalar(v)}")
                    }
                }
            }
        }
    }
}

// Reads/writes ~/.xpreiide/config.yaml directly (bypassing IntelliJ's own
// PersistentStateComponent XML storage) so this plugin shares the exact
// same config file VS Code and the Eclipse plugin read/write. NOT
// compiled or tested in this environment (no local JDK/Gradle available)
// — verify against a real IntelliJ sandbox before relying on it.
object XpreiSharedConfig {
    private fun configFile(): File =
        Paths.get(System.getProperty("user.home"), ".xpreiide", "config.yaml").toFile()

    fun load(): Pair<MutableList<ProviderConfigState>, String> {
        val file = configFile()
        if (!file.exists()) {
            return Pair(
                mutableListOf(
                    ProviderConfigState(
                        id = "ollama-local", kind = "ollama",
                        label = "Ollama (local)", baseUrl = "http://localhost:11434",
                    ),
                ),
                "",
            )
        }
        val raw = XpreiYamlLite.parse(file.readText())
        @Suppress("UNCHECKED_CAST")
        val providersRaw = raw["providers"] as? List<Any?> ?: emptyList()
        val providers = providersRaw.mapNotNull { entry ->
            @Suppress("UNCHECKED_CAST")
            val e = entry as? Map<String, Any?> ?: return@mapNotNull null
            val id = e["id"] as? String ?: return@mapNotNull null
            val kind = e["kind"] as? String ?: return@mapNotNull null
            val label = e["label"] as? String ?: return@mapNotNull null
            val baseUrl = e["baseUrl"] as? String ?: return@mapNotNull null
            ProviderConfigState(id, kind, label, baseUrl, (e["model"] as? String) ?: "")
        }.toMutableList()
        val activeModel = raw["activeModel"] as? String ?: ""
        return Pair(providers, activeModel)
    }

    fun save(providers: List<ProviderConfigState>, activeModel: String) {
        val file = configFile()
        file.parentFile?.mkdirs()
        val existingRaw = if (file.exists()) XpreiYamlLite.parse(file.readText()) else emptyMap()
        val merged = existingRaw.toMutableMap()
        merged["providers"] = providers.map {
            linkedMapOf<String, Any?>(
                "id" to it.id, "kind" to it.kind, "label" to it.label, "baseUrl" to it.baseUrl,
            ).also { m -> if (it.model.isNotEmpty()) m["model"] = it.model }
        }
        merged["activeModel"] = activeModel
        file.writeText(XpreiYamlLite.stringify(merged))
    }
}

// Application-level (global) settings, matching VS Code's user-level
// (not per-project) provider/model scope. The PersistentStateComponent
// wiring below is kept so this class still registers as an IntelliJ
// application service the same way it always has, but getState/
// loadState are no longer the source of truth for provider/model data —
// every read/write method now goes straight through XpreiSharedConfig,
// backed by the same ~/.xpreiide/config.yaml VS Code and the Eclipse
// plugin use. NOT compiled or tested in this environment (no local
// JDK/Gradle available) — verify against a real IntelliJ sandbox before
// relying on it.
@State(name = "XpreiSettings", storages = [Storage("xpreiIDE.xml")])
@Service(Service.Level.APP)
class XpreiSettingsState : PersistentStateComponent<XpreiSettingsData> {
    private var data = XpreiSettingsData()

    override fun getState(): XpreiSettingsData = data

    override fun loadState(state: XpreiSettingsData) {
        XmlSerializerUtil.copyBean(state, data)
    }

    fun getConfigs(): List<ProviderConfigState> = XpreiSharedConfig.load().first

    fun addOrUpdate(cfg: ProviderConfigState) {
        val (providers, activeModel) = XpreiSharedConfig.load()
        providers.removeIf { it.id == cfg.id }
        providers.add(cfg)
        XpreiSharedConfig.save(providers, activeModel)
    }

    fun remove(id: String) {
        val (providers, activeModel) = XpreiSharedConfig.load()
        providers.removeIf { it.id == id }
        XpreiSharedConfig.save(providers, activeModel)
    }

    fun getActiveModel(): String = XpreiSharedConfig.load().second

    fun setActiveModel(pointer: String) {
        val (providers, _) = XpreiSharedConfig.load()
        XpreiSharedConfig.save(providers, pointer)
    }

    companion object {
        fun getInstance(): XpreiSettingsState =
            ApplicationManager.getApplication().getService(XpreiSettingsState::class.java)
    }
}
