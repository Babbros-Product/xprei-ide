package online.xprei.ide.eclipse;

import org.eclipse.swt.dnd.Clipboard;
import org.eclipse.swt.dnd.TextTransfer;
import org.eclipse.swt.dnd.Transfer;
import org.eclipse.swt.widgets.Display;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.regex.Pattern;

import static online.xprei.ide.eclipse.MiniJson.arr;
import static online.xprei.ide.eclipse.MiniJson.asArr;
import static online.xprei.ide.eclipse.MiniJson.asInt;
import static online.xprei.ide.eclipse.MiniJson.asObj;
import static online.xprei.ide.eclipse.MiniJson.asStr;
import static online.xprei.ide.eclipse.MiniJson.obj;

/**
 * Translates between the webview's message protocol — identical to VS
 * Code's {@code extensions/vscode/src/ui/chat/chatView.ts}, verified
 * against that file's actual source this session, not reconstructed from
 * memory — and the sidecar's JSON-RPC protocol
 * ({@code packages/core/src/server/session.ts}). This is the Eclipse/Java +
 * MiniJson port of the IntelliJ plugin's {@code XpreiHostBridge.kt}; keep
 * the two in sync manually, since there's no module shared between the two
 * JVM plugins (different languages, different build tools) and
 * {@code @xprei/core} (TypeScript).
 *
 * <p>Same MVP-scope simplifications as the IntelliJ plugin (see
 * {@code extensions/eclipse/README.md} and this class's IntelliJ counterpart's
 * header comment for the full list): single in-memory chat session,
 * insertAtCursor/applyEdit are no-ops, no revert-last-run command wired to a
 * menu yet (the sidecar RPC exists and is tested), agent file edits trigger
 * a workspace refresh via {@link #onFileWritten} rather than any webview
 * message (chat.js has no "file changed" case — that's a VS Code
 * TextEditorDecoration, purely visual, not part of the shared protocol).
 */
public final class XpreiHostBridge {
    private static final int MAX_PREVIEW = 800;
    private static final Pattern NON_ALNUM = Pattern.compile("[^a-z0-9]+");
    private static final Pattern LEADING_TRAILING_DASH = Pattern.compile("^-+|-+$");

    private final String workspaceRoot;
    private final Consumer<Object> postToWebview;
    private final SidecarProcess sidecar;

    private final AtomicInteger rpcIdSeq = new AtomicInteger(1);
    private final Map<Integer, Consumer<Map<String, Object>>> pendingRpc = new ConcurrentHashMap<>();
    private final AtomicInteger requestSeq = new AtomicInteger(1);

    // [role, content] pairs, Plan-mode only — mirrors chatView.ts's `history`.
    private final List<String[]> history = new ArrayList<>();
    private final StringBuilder streamingAssistant = new StringBuilder();
    private String pendingApprovalId;
    private String inflightRequestId;

    /** Set by XpreiChatView after construction so agent.edit can refresh the workspace. */
    public Consumer<String> onFileWritten;

    public XpreiHostBridge(String workspaceRoot, Consumer<Object> postToWebview) {
        this.workspaceRoot = workspaceRoot;
        this.postToWebview = postToWebview;
        this.sidecar = new SidecarProcess(this::handleSidecarLine);
    }

    public void start() throws IOException {
        sidecar.start();
        reinitializeSidecarProviders();
    }

    public void stop() {
        sidecar.stop();
    }

    // ---- Webview -> host ----

    /** Entry point for messages FROM the webview (XpreiChatView's BrowserFunction forwards the raw string here). */
    public void onWebviewMessage(String json) {
        Map<String, Object> msg;
        try {
            msg = asObj(MiniJson.parse(json));
        } catch (Exception e) {
            System.err.println("xpreiIDE: bad webview message JSON: " + json);
            return;
        }
        String type = asStr(msg.get("type"), "");
        switch (type) {
            case "ready":
                onReady();
                break;
            case "send":
                onSend(msg);
                break;
            case "stop":
                onStop();
                break;
            case "reset":
                history.clear();
                break;
            case "newChat":
                history.clear();
                postToWebview.accept(obj("type", "clearTranscript"));
                break;
            case "switchSession":
                break; // single-session MVP: nothing to switch to
            case "selectModel":
                onSelectModel(asStr(msg.get("pointer"), ""));
                break;
            case "getProviders":
                sendProviders();
                break;
            case "saveProvider":
                onSaveProvider(msg);
                break;
            case "removeProvider":
                onRemoveProvider(asStr(msg.get("id"), ""));
                break;
            case "approvalResponse":
                onApprovalResponse(asStr(msg.get("choice"), "approve"));
                break;
            case "copyToClipboard":
                copyToClipboard(asStr(msg.get("text"), ""));
                break;
            case "insertAtCursor":
            case "applyEdit":
                System.out.println("xpreiIDE: '" + type + "' not implemented on Eclipse yet (fast-follow)");
                break;
            case "editLastUser":
                truncateLastUserTurn();
                break;
            case "regenerate":
                regenerate();
                break;
            default:
                System.err.println("xpreiIDE: unknown webview message type: " + type);
        }
    }

    private void onReady() {
        sendModels();
        sendProviders();
        postToWebview.accept(
            obj("type", "sessions", "items", arr(obj("id", "default", "title", "Chat", "active", true))));
    }

    private void onSend(Map<String, Object> msg) {
        String text = asStr(msg.get("text"), "").trim();
        if (text.isEmpty() || inflightRequestId != null) return;
        String mode = asStr(msg.get("mode"), "plan");
        if ("plan".equals(mode)) sendPlainChat(text);
        else runAgentTask(text, mode);
    }

    private void onStop() {
        if (inflightRequestId == null) return;
        String id = inflightRequestId;
        if (id.startsWith("chat-")) sendNotify("chat.stop", obj("requestId", id));
        else sendNotify("agent.stop", obj("requestId", id));
    }

    private void onSelectModel(String pointer) {
        if (pointer.isEmpty()) return;
        XpreiSettings.setActiveModel(pointer);
        sendModels();
    }

    private void onSaveProvider(Map<String, Object> msg) {
        Map<String, Object> cfgObj = asObj(msg.get("cfg"));
        String kind = "ollama".equals(asStr(cfgObj.get("kind"), "")) ? "ollama" : "openai-compat";
        String label = asStr(cfgObj.get("label"), "").trim();
        String baseUrl = asStr(cfgObj.get("baseUrl"), "").trim();
        String model = asStr(cfgObj.get("model"), "").trim();
        String apiKey = asStr(msg.get("apiKey"), "");
        if (baseUrl.isEmpty()) {
            postToWebview.accept(obj("type", "error", "text", "Provider needs a base URL."));
            return;
        }

        Set<String> existingIds = XpreiSettings.getProviderIds();
        String id = uniqueProviderId(slugify(label, kind), existingIds);
        String finalLabel = label.isEmpty() ? id : label;

        XpreiSettings.addOrUpdate(
            obj("id", id, "kind", kind, "label", finalLabel, "baseUrl", baseUrl, "model", model));
        if ("openai-compat".equals(kind) && !apiKey.isEmpty()) XpreiSecrets.set(id, apiKey);

        postToWebview.accept(obj("type", "info", "text", "Added provider " + finalLabel + "."));
        sendProviders();
        sendModels();
        reinitializeSidecarProviders(); // sidecar caches provider config from `initialize`; resync it
    }

    private void onRemoveProvider(String id) {
        if (id.isEmpty()) return;
        XpreiSettings.remove(id);
        XpreiSecrets.remove(id);
        sendProviders();
        sendModels();
        reinitializeSidecarProviders();
    }

    private void onApprovalResponse(String choice) {
        if (pendingApprovalId == null) return;
        String id = pendingApprovalId;
        pendingApprovalId = null;
        sendNotify("agent.approve", obj("approvalId", id, "choice", choice));
    }

    private void copyToClipboard(String text) {
        Display display = Display.getCurrent();
        if (display == null) display = Display.getDefault();
        Clipboard clipboard = new Clipboard(display);
        try {
            clipboard.setContents(new Object[] {text}, new Transfer[] {TextTransfer.getInstance()});
        } finally {
            clipboard.dispose();
        }
    }

    private void truncateLastUserTurn() {
        if (!history.isEmpty() && "assistant".equals(history.get(history.size() - 1)[0])) {
            history.remove(history.size() - 1);
        }
        if (!history.isEmpty() && "user".equals(history.get(history.size() - 1)[0])) {
            history.remove(history.size() - 1);
        }
    }

    private void regenerate() {
        if (inflightRequestId != null) return;
        if (!history.isEmpty() && "assistant".equals(history.get(history.size() - 1)[0])) {
            history.remove(history.size() - 1);
        }
        if (history.isEmpty()) return;
        String[] prior = history.get(history.size() - 1);
        if (!"user".equals(prior[0])) return;
        history.remove(history.size() - 1);
        sendPlainChat(prior[1]);
    }

    // ---- Outbound sidecar calls ----

    private void reinitializeSidecarProviders() {
        List<Map<String, Object>> providers = XpreiSettings.getProviders();
        List<Object> providersJson = new ArrayList<>();
        Map<String, Object> apiKeys = new LinkedHashMap<>();
        for (Map<String, Object> p : providers) {
            String id = asStr(p.get("id"), "");
            Map<String, Object> entry = obj(
                "id", id, "kind", asStr(p.get("kind"), ""), "label", asStr(p.get("label"), ""),
                "baseUrl", asStr(p.get("baseUrl"), ""));
            String model = asStr(p.get("model"), "");
            if (!model.isEmpty()) entry.put("model", model);
            providersJson.add(entry);
            String key = XpreiSecrets.get(id);
            if (key != null) apiKeys.put(id, key);
        }
        sendRequest(
            "initialize",
            obj("workspaceRoot", workspaceRoot, "providers", providersJson, "apiKeys", apiKeys),
            null);
    }

    private void sendModels() {
        String activePointer = XpreiSettings.getActiveModel();
        sendRequest("models.list", obj("activePointer", activePointer), resp -> {
            Map<String, Object> result = asObj(resp.get("result"));
            Object items = result.get("items");
            postToWebview.accept(obj("type", "models", "items", items == null ? arr() : items));
        });
    }

    private void sendProviders() {
        List<Object> items = new ArrayList<>(XpreiSettings.getProviders());
        postToWebview.accept(obj("type", "providers", "items", items));
    }

    private void sendPlainChat(String text) {
        String pointer = XpreiSettings.getActiveModel();
        if (pointer.isEmpty()) {
            postToWebview.accept(obj("type", "error", "text", "No model selected."));
            return;
        }
        history.add(new String[] {"user", text});
        postToWebview.accept(obj("type", "start"));

        String requestId = "chat-" + requestSeq.getAndIncrement();
        inflightRequestId = requestId;
        streamingAssistant.setLength(0);

        List<Object> messages = new ArrayList<>();
        messages.add(obj(
            "role", "system",
            "content", "You are xpreiIDE in Plan mode: a concise coding assistant embedded in the "
                + "user's IDE. Analyze and propose an approach in prose or code snippets. "
                + "You have no file-editing tools in this mode — never claim to have created "
                + "or modified a file; suggest switching to Edit or Agent mode for that."));
        for (String[] turn : history) messages.add(obj("role", turn[0], "content", turn[1]));

        sendRequest("chat.send", obj("requestId", requestId, "model", pointer, "messages", messages), null);
    }

    private void runAgentTask(String task, String mode) {
        String pointer = XpreiSettings.getActiveModel();
        if (pointer.isEmpty()) {
            postToWebview.accept(obj("type", "error", "text", "No model selected."));
            return;
        }
        String requestId = "agent-" + requestSeq.getAndIncrement();
        inflightRequestId = requestId;
        postToWebview.accept(obj("type", "agent", "kind", "start"));
        sendRequest("agent.run", obj("requestId", requestId, "model", pointer, "task", task, "mode", mode), null);
    }

    // ---- Sidecar -> host ----

    private void handleSidecarLine(String line) {
        Map<String, Object> msg;
        try {
            msg = asObj(MiniJson.parse(line));
        } catch (Exception e) {
            System.err.println("xprei sidecar: bad JSON line: " + line);
            return;
        }
        Object idValue = msg.get("id");
        if (idValue instanceof Number) {
            Consumer<Map<String, Object>> cb = pendingRpc.remove(((Number) idValue).intValue());
            if (cb != null) cb.accept(msg);
            return;
        }
        String method = asStr(msg.get("method"), null);
        if (method == null) return;
        handleSidecarEvent(method, asObj(msg.get("params")));
    }

    private void handleSidecarEvent(String method, Map<String, Object> params) {
        String requestId = asStr(params.get("requestId"), null);
        switch (method) {
            case "chat.delta": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                String delta = asStr(params.get("delta"), null);
                if (delta == null) return;
                streamingAssistant.append(delta);
                postToWebview.accept(obj("type", "delta", "text", delta));
                break;
            }
            case "chat.done": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                history.add(new String[] {"assistant", streamingAssistant.toString()});
                inflightRequestId = null;
                postToWebview.accept(obj("type", "done"));
                break;
            }
            case "chat.error": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                inflightRequestId = null;
                postToWebview.accept(obj("type", "error", "text", asStr(params.get("message"), "chat error")));
                break;
            }
            case "agent.step": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                postToWebview.accept(obj("type", "agent", "kind", "step", "n", asInt(params.get("n"), 0)));
                break;
            }
            case "agent.thought": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                postToWebview.accept(obj("type", "agent", "kind", "thought", "text", params.get("text")));
                break;
            }
            case "agent.tool": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                String name = asStr(params.get("name"), "");
                Map<String, Object> args = asObj(params.get("args"));
                postToWebview.accept(
                    obj("type", "agent", "kind", "tool", "text", summarizeTool(name, args), "name", name));
                break;
            }
            case "agent.observation": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                postToWebview.accept(obj("type", "agent", "kind", "observation", "text", params.get("text")));
                break;
            }
            case "agent.final": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                postToWebview.accept(obj("type", "agent", "kind", "final", "text", params.get("text")));
                postToWebview.accept(obj("type", "agent", "kind", "end"));
                inflightRequestId = null;
                break;
            }
            case "agent.error": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                postToWebview.accept(obj("type", "agent", "kind", "error", "text", params.get("text")));
                postToWebview.accept(obj("type", "agent", "kind", "end"));
                inflightRequestId = null;
                break;
            }
            case "agent.edit": {
                // No webview message for this — see the class header comment
                // and the IntelliJ plugin's identical note.
                String relPath = asStr(params.get("path"), null);
                if (relPath != null && onFileWritten != null) onFileWritten.accept(relPath);
                break;
            }
            case "agent.approvalRequest": {
                if (!Objects.equals(requestId, inflightRequestId)) return;
                String approvalId = asStr(params.get("approvalId"), null);
                if (approvalId == null) return;
                String tool = asStr(params.get("tool"), "");
                Map<String, Object> args = asObj(params.get("args"));
                pendingApprovalId = approvalId;
                String[] diff = buildDiffPreview(tool, args);
                postToWebview.accept(obj(
                    "type", "agent", "kind", "approval", "tool", tool,
                    "text", summarizeTool(tool, args),
                    "before", diff[0], "after", diff[1]));
                break;
            }
            default:
                break;
        }
    }

    // ---- Wire helpers ----

    private void sendRequest(String method, Map<String, Object> params, Consumer<Map<String, Object>> onResult) {
        int id = rpcIdSeq.getAndIncrement();
        if (onResult != null) pendingRpc.put(id, onResult);
        sidecar.send(MiniJson.stringify(obj("id", id, "method", method, "params", params)));
    }

    private void sendNotify(String method, Map<String, Object> params) {
        sidecar.send(MiniJson.stringify(obj("method", method, "params", params)));
    }

    // ---- Ported 1:1 from extensions/vscode/src/agent/runner.ts's
    // summarize()/buildDiffPreview() (also ported to the IntelliJ plugin's
    // XpreiHostBridge.kt) — kept in sync manually. ----

    private static String clip(String s) {
        return s.length() > MAX_PREVIEW ? s.substring(0, MAX_PREVIEW) + "\n… (truncated)" : s;
    }

    static String summarizeTool(String tool, Map<String, Object> args) {
        if ("run_terminal".equals(tool)) return "$ " + asStr(args.get("command"), "");
        String path = asStr(args.get("path"), "?");
        if ("create_file".equals(tool)) {
            String content = asStr(args.get("content"), "");
            return "Create " + path + " (" + content.length() + " bytes)";
        }
        if ("edit_file".equals(tool)) {
            return args.get("find") == null ? "Overwrite " + path : "Edit " + path;
        }
        return path;
    }

    /** Returns {@code [before, after]} — either element may be {@code null}. */
    static String[] buildDiffPreview(String tool, Map<String, Object> args) {
        if ("create_file".equals(tool)) {
            return new String[] {null, clip(asStr(args.get("content"), ""))};
        }
        if ("edit_file".equals(tool)) {
            Object findValue = args.get("find");
            String replace = asStr(args.get("replace"), "");
            if (findValue == null) return new String[] {null, clip(replace)};
            return new String[] {clip(String.valueOf(findValue)), clip(replace)};
        }
        return new String[] {null, null};
    }

    private static String slugify(String label, String fallback) {
        String slug = LEADING_TRAILING_DASH
            .matcher(NON_ALNUM.matcher(label.toLowerCase()).replaceAll("-"))
            .replaceAll("");
        return slug.isEmpty() ? fallback : slug;
    }

    private static String uniqueProviderId(String base, Set<String> existing) {
        if (!existing.contains(base)) return base;
        int n = 2;
        while (existing.contains(base + "-" + n)) n++;
        return base + "-" + n;
    }
}
