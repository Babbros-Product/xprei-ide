package online.xprei.ide

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import javax.swing.JComponent
import javax.swing.JPanel

// Hosts the shared xpreiIDE webview (webview/index.html + chat.js/css +
// bridge.js, extracted from plugin resources by WebviewResources) inside a
// JBCefBrowser, and wires it to XpreiHostBridge over the SAME
// window.xpreiHostBridge / window.__xpreiReceive contract webview/bridge.js
// already implements for any non-VS-Code host — no webview-side code is
// JetBrains-specific.
class XpreiChatPanel(project: Project) : Disposable {
    private val gson = Gson()
    private val browser = JBCefBrowser()
    private val jsQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val bridge = XpreiHostBridge(project) { event -> pushToWebview(event) }

    val component: JComponent = JPanel(BorderLayout()).apply {
        add(browser.component, BorderLayout.CENTER)
    }

    init {
        // JS -> Kotlin: bridge.js calls window.xpreiHostBridge.postMessage(json);
        // that call is injected (below, onLoadEnd) to round-trip through this query.
        jsQuery.addHandler { json ->
            bridge.onWebviewMessage(json)
            null
        }

        browser.jbCefClient.addLoadHandler(
            object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                    if (frame?.isMain != true) return
                    // Give the page window.xpreiHostBridge.postMessage(jsonString);
                    // webview/bridge.js picks this up automatically (see its
                    // "else" branch — the non-VS-Code, non-acquireVsCodeApi path).
                    cefBrowser?.executeJavaScript(
                        "window.xpreiHostBridge = { postMessage: function(json) { ${jsQuery.inject("json")} } };",
                        cefBrowser.url,
                        0,
                    )
                }
            },
            browser.cefBrowser,
        )

        val indexFile = WebviewResources.extractWebviewDir().resolve("index.html")
        browser.loadURL(indexFile.toURI().toString())
        bridge.start()
    }

    // Kotlin -> JS: push one event down via the global window.__xpreiReceive
    // bridge.js installs. Runs on the UI thread since it touches the browser.
    private fun pushToWebview(event: JsonElement) {
        val jsonString = gson.toJson(event)
        // Re-serialize the JSON string itself so it splices safely as a JS
        // string literal (handles quotes/backslashes/newlines); bridge.js's
        // __xpreiReceive does typeof-check + JSON.parse on the string side.
        val jsStringLiteral = gson.toJson(jsonString)
        ApplicationManager.getApplication().invokeLater {
            browser.cefBrowser.executeJavaScript(
                "window.__xpreiReceive && window.__xpreiReceive($jsStringLiteral);",
                browser.cefBrowser.url,
                0,
            )
        }
    }

    override fun dispose() {
        bridge.stop()
        Disposer.dispose(jsQuery)
        Disposer.dispose(browser)
    }
}
