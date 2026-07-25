package online.xprei.ide

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

// Translates between the webview's message protocol — IDENTICAL to VS Code's
// extensions/vscode/src/ui/chat/chatView.ts, verified against that file's
// actual .post()/onDidReceiveMessage source, not reconstructed from memory —
// and the sidecar's JSON-RPC protocol (packages/core/src/server/session.ts).
// This class is the JetBrains equivalent of chatView.ts + agent/runner.ts
// combined; XpreiChatPanel owns the JCEF plumbing and just forwards raw JSON
// strings both directions through onWebviewMessage() / the postToWebview callback.
//
// MVP scope only (per docs/multi-ide-plan.md): chat + BYO-model + agent loop
// with approvals/revert-adjacent VFS refresh. Deliberately simplified vs the
// VS Code extension, flagged inline below and in extensions/intellij/README.md:
//   - Single in-memory chat session (no cross-restart persistence, no
//     multi-session history panel — "newChat"/"switchSession" are minimal).
//   - insertAtCursor / applyEdit (chat code-block actions) are no-ops.
//   - No @codebase RAG, inline-edit diff, ghost-text completions, or
//     commit-message generation (all fast-follow, out of MVP scope already).
//   - No revert-last-run action wired to a command yet (the sidecar's
//     agent.revert RPC exists and works — see packages/core tests — this
//     class just doesn't expose a menu entry for it yet).
class XpreiHostBridge(private val project: Project, private val postToWebview: (JsonElement) -> Unit) {
    private val log = Logger.getInstance(XpreiHostBridge::class.java)
    private val gson = Gson()

    private val rpcIdSeq = AtomicInteger(1)
    private val pendingRpc = ConcurrentHashMap<Int, (JsonObject) -> Unit>()
    private val requestSeq = AtomicInteger(1)

    // {role, content} turns, Plan-mode only — mirrors chatView.ts's `history`.
    private val history = mutableListOf<Pair<String, String>>()
    private val streamingAssistant = StringBuilder()
    private var pendingApprovalId: String? = null
    private var inflightRequestId: String? = null

    private val sidecar = SidecarProcess { line -> handleSidecarLine(line) }

    fun start() {
        sidecar.start()
        reinitializeSidecarProviders()
    }

    fun stop() {
        sidecar.stop()
    }

    // ---- Webview -> host ----------------------------------------------

    // Entry point for messages FROM the webview (JS calls
    // window.xpreiHostBridge.postMessage(json); XpreiChatPanel's JBCefJSQuery
    // handler forwards the raw string here unchanged).
    fun onWebviewMessage(json: String) {
        val msg = try {
            gson.fromJson(json, JsonObject::class.java)
        } catch (e: Exception) {
            log.warn("xpreiIDE: bad webview message JSON: $json", e)
            return
        }
        when (msg.get("type")?.asString) {
            "ready" -> onReady()
            "send" -> onSend(msg)
            "stop" -> onStop()
            "reset" -> history.clear()
            "newChat" -> {
                history.clear()
                postToWebview(obj("type" to "clearTranscript"))
            }
            "switchSession" -> Unit // single-session MVP: nothing to switch to
            "selectModel" -> onSelectModel(msg.get("pointer")?.asString.orEmpty())
            "getProviders" -> sendProviders()
            "saveProvider" -> onSaveProvider(msg)
            "removeProvider" -> onRemoveProvider(msg.get("id")?.asString.orEmpty())
            "approvalResponse" -> onApprovalResponse(msg.get("choice")?.asString ?: "approve")
            "copyToClipboard" -> copyToClipboard(msg.get("text")?.asString.orEmpty())
            "insertAtCursor", "applyEdit" ->
                log.info("xpreiIDE: '${msg.get("type")?.asString}' not implemented on JetBrains yet (fast-follow)")
            "editLastUser" -> truncateLastUserTurn()
            "regenerate" -> regenerate()
            else -> log.warn("xpreiIDE: unknown webview message type: ${msg.get("type")}")
        }
    }

    private fun onReady() {
        sendModels()
        sendProviders()
        postToWebview(
            obj(
                "type" to "sessions",
                "items" to listOf(obj("id" to "default", "title" to "Chat", "active" to true)),
            ),
        )
    }

    private fun onSend(msg: JsonObject) {
        val text = msg.get("text")?.asString?.trim().orEmpty()
        if (text.isEmpty() || inflightRequestId != null) return
        val mode = msg.get("mode")?.asString ?: "plan"
        if (mode == "plan") sendPlainChat(text) else runAgentTask(text, mode)
    }

    private fun onStop() {
        val id = inflightRequestId ?: return
        if (id.startsWith("chat-")) sendNotify("chat.stop", obj("requestId" to id))
        else sendNotify("agent.stop", obj("requestId" to id))
    }

    private fun onSelectModel(pointer: String) {
        if (pointer.isEmpty()) return
        XpreiSettingsState.getInstance().setActiveModel(pointer)
        sendModels()
    }

    private fun onSaveProvider(msg: JsonObject) {
        val cfgObj = msg.getAsJsonObject("cfg") ?: JsonObject()
        val kind = if (cfgObj.get("kind")?.asString == "ollama") "ollama" else "openai-compat"
        val label = cfgObj.get("label")?.asString?.trim().orEmpty()
        val baseUrl = cfgObj.get("baseUrl")?.asString?.trim().orEmpty()
        val model = cfgObj.get("model")?.asString?.trim().orEmpty()
        val apiKey = msg.get("apiKey")?.asString.orEmpty()
        if (baseUrl.isEmpty()) {
            postToWebview(obj("type" to "error", "text" to "Provider needs a base URL."))
            return
        }

        val settings = XpreiSettingsState.getInstance()
        val existingIds = settings.getConfigs().map { it.id }.toSet()
        val id = uniqueProviderId(slugify(label, kind), existingIds)
        val finalLabel = label.ifEmpty { id }
        settings.addOrUpdate(
            ProviderConfigState(id = id, kind = kind, label = finalLabel, baseUrl = baseUrl, model = model),
        )
        if (kind == "openai-compat" && apiKey.isNotEmpty()) XpreiSecrets.set(id, apiKey)

        postToWebview(obj("type" to "info", "text" to "Added provider $finalLabel."))
        sendProviders()
        sendModels()
        reinitializeSidecarProviders() // sidecar caches provider config from `initialize`; resync it
    }

    private fun onRemoveProvider(id: String) {
        if (id.isEmpty()) return
        XpreiSettingsState.getInstance().remove(id)
        XpreiSecrets.remove(id)
        sendProviders()
        sendModels()
        reinitializeSidecarProviders()
    }

    private fun onApprovalResponse(choice: String) {
        val id = pendingApprovalId ?: return
        pendingApprovalId = null
        sendNotify("agent.approve", obj("approvalId" to id, "choice" to choice))
    }

    private fun copyToClipboard(text: String) {
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null)
    }

    private fun truncateLastUserTurn() {
        if (history.isNotEmpty() && history.last().first == "assistant") history.removeAt(history.size - 1)
        if (history.isNotEmpty() && history.last().first == "user") history.removeAt(history.size - 1)
    }

    private fun regenerate() {
        if (inflightRequestId != null) return
        if (history.isNotEmpty() && history.last().first == "assistant") history.removeAt(history.size - 1)
        val prior = history.lastOrNull() ?: return
        if (prior.first != "user") return
        history.removeAt(history.size - 1)
        sendPlainChat(prior.second)
    }

    // ---- Outbound sidecar calls ----------------------------------------

    private fun reinitializeSidecarProviders() {
        val cfg = XpreiSettingsState.getInstance()
        val providers = JsonArray()
        val apiKeys = JsonObject()
        for (p in cfg.getConfigs()) {
            val entry = obj("id" to p.id, "kind" to p.kind, "label" to p.label, "baseUrl" to p.baseUrl)
            if (p.model.isNotEmpty()) entry.addProperty("model", p.model)
            providers.add(entry)
            XpreiSecrets.get(p.id)?.let { apiKeys.addProperty(p.id, it) }
        }
        sendRequest(
            "initialize",
            obj(
                "workspaceRoot" to (project.basePath ?: "."),
                "providers" to providers,
                "apiKeys" to apiKeys,
            ),
        )
    }

    private fun sendModels() {
        val activePointer = XpreiSettingsState.getInstance().getActiveModel()
        sendRequest("models.list", obj("activePointer" to activePointer)) { resp ->
            val items = resp.getAsJsonObject("result")?.getAsJsonArray("items") ?: JsonArray()
            postToWebview(obj("type" to "models", "items" to items))
        }
    }

    private fun sendProviders() {
        val items = XpreiSettingsState.getInstance().getConfigs().map {
            obj("id" to it.id, "kind" to it.kind, "label" to it.label, "baseUrl" to it.baseUrl, "model" to it.model)
        }
        postToWebview(obj("type" to "providers", "items" to items))
    }

    private fun sendPlainChat(text: String) {
        val pointer = XpreiSettingsState.getInstance().getActiveModel()
        if (pointer.isEmpty()) {
            postToWebview(obj("type" to "error", "text" to "No model selected."))
            return
        }
        history.add("user" to text)
        postToWebview(obj("type" to "start"))

        val requestId = "chat-" + requestSeq.getAndIncrement()
        inflightRequestId = requestId
        streamingAssistant.setLength(0)

        val messages = JsonArray()
        messages.add(
            obj(
                "role" to "system",
                "content" to (
                    "You are xpreiIDE in Plan mode: a concise coding assistant embedded in the " +
                        "user's IDE. Analyze and propose an approach in prose or code snippets. " +
                        "You have no file-editing tools in this mode — never claim to have created " +
                        "or modified a file; suggest switching to Edit or Agent mode for that."
                    ),
            ),
        )
        for ((role, content) in history) messages.add(obj("role" to role, "content" to content))

        sendRequest(
            "chat.send",
            obj("requestId" to requestId, "model" to pointer, "messages" to messages),
        )
    }

    private fun runAgentTask(task: String, mode: String) {
        val pointer = XpreiSettingsState.getInstance().getActiveModel()
        if (pointer.isEmpty()) {
            postToWebview(obj("type" to "error", "text" to "No model selected."))
            return
        }
        val requestId = "agent-" + requestSeq.getAndIncrement()
        inflightRequestId = requestId
        postToWebview(obj("type" to "agent", "kind" to "start"))
        sendRequest(
            "agent.run",
            obj("requestId" to requestId, "model" to pointer, "task" to task, "mode" to mode),
        )
    }

    // ---- Sidecar -> host -------------------------------------------------

    private fun handleSidecarLine(line: String) {
        val msg = try {
            gson.fromJson(line, JsonObject::class.java)
        } catch (e: Exception) {
            log.warn("xprei sidecar: bad JSON line: $line", e)
            return
        }
        val idElement = msg.get("id")
        if (idElement != null && !idElement.isJsonNull) {
            pendingRpc.remove(idElement.asInt)?.invoke(msg)
            return
        }
        val method = msg.get("method")?.asString ?: return
        val params = msg.getAsJsonObject("params") ?: JsonObject()
        handleSidecarEvent(method, params)
    }

    private fun handleSidecarEvent(method: String, params: JsonObject) {
        val requestId = params.get("requestId")?.asString
        when (method) {
            "chat.delta" -> {
                if (requestId != inflightRequestId) return
                val delta = params.get("delta")?.asString ?: return
                streamingAssistant.append(delta)
                postToWebview(obj("type" to "delta", "text" to delta))
            }
            "chat.done" -> {
                if (requestId != inflightRequestId) return
                history.add("assistant" to streamingAssistant.toString())
                inflightRequestId = null
                postToWebview(obj("type" to "done"))
            }
            "chat.error" -> {
                if (requestId != inflightRequestId) return
                inflightRequestId = null
                postToWebview(obj("type" to "error", "text" to (params.get("message")?.asString ?: "chat error")))
            }
            "agent.step" -> {
                if (requestId != inflightRequestId) return
                postToWebview(obj("type" to "agent", "kind" to "step", "n" to (params.get("n")?.asInt ?: 0)))
            }
            "agent.thought" -> {
                if (requestId != inflightRequestId) return
                postToWebview(obj("type" to "agent", "kind" to "thought", "text" to params.get("text")?.asString))
            }
            "agent.tool" -> {
                if (requestId != inflightRequestId) return
                val name = params.get("name")?.asString ?: ""
                val args = params.getAsJsonObject("args") ?: JsonObject()
                postToWebview(
                    obj("type" to "agent", "kind" to "tool", "text" to summarizeTool(name, args), "name" to name),
                )
            }
            "agent.observation" -> {
                if (requestId != inflightRequestId) return
                postToWebview(obj("type" to "agent", "kind" to "observation", "text" to params.get("text")?.asString))
            }
            "agent.final" -> {
                if (requestId != inflightRequestId) return
                postToWebview(obj("type" to "agent", "kind" to "final", "text" to params.get("text")?.asString))
                postToWebview(obj("type" to "agent", "kind" to "end"))
                inflightRequestId = null
            }
            "agent.error" -> {
                if (requestId != inflightRequestId) return
                postToWebview(obj("type" to "agent", "kind" to "error", "text" to params.get("text")?.asString))
                postToWebview(obj("type" to "agent", "kind" to "end"))
                inflightRequestId = null
            }
            "agent.edit" -> {
                // No webview message for this — chat.js has no "file changed,
                // flash the gutter" case (that's a VS Code TextEditorDecoration,
                // purely visual sugar). The JetBrains equivalent minimum is a
                // VFS refresh so an already-open editor doesn't show stale
                // content or a "changed on disk" conflict banner.
                val relPath = params.get("path")?.asString ?: return
                val absFile = File(project.basePath ?: ".", relPath)
                ApplicationManager.getApplication().invokeLater {
                    LocalFileSystem.getInstance().refreshAndFindFileByIoFile(absFile)
                }
            }
            "agent.approvalRequest" -> {
                if (requestId != inflightRequestId) return
                val approvalId = params.get("approvalId")?.asString ?: return
                val tool = params.get("tool")?.asString ?: ""
                val args = params.getAsJsonObject("args") ?: JsonObject()
                pendingApprovalId = approvalId
                val (before, after) = buildDiffPreview(tool, args)
                postToWebview(
                    obj(
                        "type" to "agent",
                        "kind" to "approval",
                        "tool" to tool,
                        "text" to summarizeTool(tool, args),
                        "before" to before,
                        "after" to after,
                    ),
                )
            }
            else -> Unit
        }
    }

    // ---- Wire helpers -------------------------------------------------

    private fun sendRequest(method: String, params: JsonObject, onResult: ((JsonObject) -> Unit)? = null) {
        val id = rpcIdSeq.getAndIncrement()
        if (onResult != null) pendingRpc[id] = onResult
        val wire = JsonObject().apply {
            addProperty("id", id)
            addProperty("method", method)
            add("params", params)
        }
        sidecar.send(gson.toJson(wire))
    }

    private fun sendNotify(method: String, params: JsonObject) {
        val wire = JsonObject().apply {
            addProperty("method", method)
            add("params", params)
        }
        sidecar.send(gson.toJson(wire))
    }

    private fun obj(vararg pairs: Pair<String, Any?>): JsonObject {
        val o = JsonObject()
        for ((k, v) in pairs) o.add(k, toJsonElement(v))
        return o
    }

    // Recursive, explicit conversion — deliberately does NOT delegate a raw
    // List<*> to gson.toJsonTree(): Gson's collection adapter resolves its
    // element adapter from erased/declared generic type, and whether a
    // List<JsonObject> serializes as "the objects themselves" vs "each
    // JsonObject's internal fields reflected over" depends on Gson-version
    // internals I can't verify without compiling and running this. Recursing
    // through toJsonElement per item side-steps that ambiguity entirely: a
    // JsonElement item always hits the `is JsonElement -> v` branch, verbatim.
    private fun toJsonElement(v: Any?): JsonElement = when (v) {
        null -> JsonNull.INSTANCE
        is JsonElement -> v
        is String -> com.google.gson.JsonPrimitive(v)
        is Boolean -> com.google.gson.JsonPrimitive(v)
        is Number -> com.google.gson.JsonPrimitive(v)
        is List<*> -> JsonArray().apply { for (item in v) add(toJsonElement(item)) }
        else -> gson.toJsonTree(v)
    }

    companion object {
        // Ported 1:1 from extensions/vscode/src/agent/runner.ts's
        // summarize() / buildDiffPreview() — kept in sync manually since
        // there's no shared module between the TS core and this Kotlin plugin
        // (the sidecar protocol only carries {tool, args}, not a pre-rendered
        // summary; every host renders its own approval card).
        private const val MAX_PREVIEW = 800

        private fun clip(s: String): String =
            if (s.length > MAX_PREVIEW) s.substring(0, MAX_PREVIEW) + "\n… (truncated)" else s

        fun summarizeTool(tool: String, args: JsonObject): String {
            if (tool == "run_terminal") return "$ ${args.get("command")?.asString ?: ""}"
            val path = args.get("path")?.asString ?: "?"
            if (tool == "create_file") {
                val len = args.get("content")?.asString?.length ?: 0
                return "Create $path ($len bytes)"
            }
            if (tool == "edit_file") {
                val findElement = args.get("find")
                return if (findElement == null || findElement.isJsonNull) "Overwrite $path" else "Edit $path"
            }
            return path
        }

        fun buildDiffPreview(tool: String, args: JsonObject): Pair<String?, String?> {
            if (tool == "create_file") {
                return null to clip(args.get("content")?.asString ?: "")
            }
            if (tool == "edit_file") {
                val find = args.get("find")?.takeUnless { it.isJsonNull }?.asString
                val replace = args.get("replace")?.asString ?: ""
                return if (find == null) null to clip(replace) else clip(find) to clip(replace)
            }
            return null to null
        }

        private fun slugify(label: String, fallback: String): String {
            val slug = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
            return slug.ifEmpty { fallback }
        }

        private fun uniqueProviderId(base: String, existing: Set<String>): String {
            if (base !in existing) return base
            var n = 2
            while ("$base-$n" in existing) n++
            return "$base-$n"
        }
    }
}
