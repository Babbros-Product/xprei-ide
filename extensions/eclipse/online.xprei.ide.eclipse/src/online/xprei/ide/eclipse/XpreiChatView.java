package online.xprei.ide.eclipse;

import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.resources.IWorkspaceRoot;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.IPath;
import org.eclipse.swt.SWT;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.browser.BrowserFunction;
import org.eclipse.swt.browser.ProgressAdapter;
import org.eclipse.swt.browser.ProgressEvent;
import org.eclipse.swt.layout.FillLayout;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Display;
import org.eclipse.ui.part.ViewPart;

import java.io.File;
import java.io.IOException;

/**
 * ViewPart hosting the shared xpreiIDE webview inside an SWT {@link Browser},
 * wired to {@link XpreiHostBridge} over the SAME window.xpreiHostBridge /
 * window.__xpreiReceive contract webview/bridge.js already implements for
 * any non-VS-Code host — no webview-side code is Eclipse-specific.
 */
public final class XpreiChatView extends ViewPart {
    public static final String ID = "online.xprei.ide.eclipse.chatView";

    private Browser browser;
    private XpreiHostBridge bridge;

    @Override
    public void createPartControl(Composite parent) {
        parent.setLayout(new FillLayout());
        browser = new Browser(parent, SWT.NONE);

        // JS -> Java: bridge.js calls window.xpreiHostBridge.postMessage(json);
        // that call is injected (below) to round-trip through this function.
        new BrowserFunction(browser, "xpreiHostBridgePostMessage") {
            @Override
            public Object function(Object[] arguments) {
                if (arguments.length > 0 && arguments[0] instanceof String && bridge != null) {
                    bridge.onWebviewMessage((String) arguments[0]);
                }
                return null;
            }
        };

        browser.addProgressListener(new ProgressAdapter() {
            @Override
            public void completed(ProgressEvent event) {
                // Give the page window.xpreiHostBridge.postMessage(jsonString);
                // webview/bridge.js's non-VS-Code branch picks this up.
                browser.execute(
                    "window.xpreiHostBridge = { postMessage: function(json) { "
                        + "xpreiHostBridgePostMessage(json); } };");
            }
        });

        String workspaceRoot = resolveWorkspaceRoot();
        bridge = new XpreiHostBridge(workspaceRoot, this::pushToWebview);
        bridge.onFileWritten = this::refreshWorkspaceFile;

        try {
            File indexFile = WebviewResources.extractWebviewDir();
            browser.setUrl(new File(indexFile, "index.html").toURI().toString());
        } catch (IOException e) {
            browser.setText("<html><body>xpreiIDE failed to load: " + e.getMessage() + "</body></html>");
            return;
        }

        try {
            bridge.start();
        } catch (IOException e) {
            System.err.println("xpreiIDE: failed to start sidecar: " + e.getMessage());
        }
    }

    private String resolveWorkspaceRoot() {
        // MVP simplification: an Eclipse workspace can hold multiple projects,
        // unlike VS Code's single workspace folder or JetBrains' project.basePath.
        // Use the first open project's location if one exists, else fall back to
        // the workspace root directory itself. Multi-project workspaces aren't
        // fully modeled yet — see extensions/eclipse/README.md.
        IWorkspaceRoot root = ResourcesPlugin.getWorkspace().getRoot();
        for (IProject project : root.getProjects()) {
            if (project.isOpen()) {
                IPath location = project.getLocation();
                if (location != null) return location.toOSString();
            }
        }
        return root.getLocation().toOSString();
    }

    // Java -> JS: push one event down via the global window.__xpreiReceive
    // bridge.js installs. May be called from the sidecar's background
    // stdout-reader thread, so it always marshals onto the SWT UI thread —
    // calling Browser.execute off-thread throws SWTException.
    private void pushToWebview(Object event) {
        if (browser == null || browser.isDisposed()) return;
        String jsonString = MiniJson.stringify(event);
        // Re-serialize the JSON string itself so it splices safely as a JS
        // string literal (handles quotes/backslashes/newlines); bridge.js's
        // __xpreiReceive does typeof-check + JSON.parse on the string side.
        String jsStringLiteral = MiniJson.stringify(jsonString);
        Display display = browser.getDisplay();
        if (display == null || display.isDisposed()) return;
        display.asyncExec(() -> {
            if (!browser.isDisposed()) {
                browser.execute("window.__xpreiReceive && window.__xpreiReceive(" + jsStringLiteral + ");");
            }
        });
    }

    // Best-effort refresh so an open editor doesn't show stale content after
    // an agent write. Eclipse's IResource model is per-project, not a flat
    // filesystem tree like VS Code/JetBrains, so this refreshes every open
    // project rather than tracking which project owns the written path —
    // cheap for typical project counts, simplest correct MVP behavior.
    private void refreshWorkspaceFile(String relPath) {
        IWorkspaceRoot root = ResourcesPlugin.getWorkspace().getRoot();
        if (browser == null || browser.isDisposed()) return;
        Display display = browser.getDisplay();
        if (display == null || display.isDisposed()) return;
        display.asyncExec(() -> {
            for (IProject project : root.getProjects()) {
                if (!project.isOpen()) continue;
                try {
                    project.refreshLocal(IResource.DEPTH_INFINITE, null);
                } catch (CoreException e) {
                    // Best-effort; not fatal.
                }
            }
        });
    }

    @Override
    public void setFocus() {
        if (browser != null && !browser.isDisposed()) browser.setFocus();
    }

    @Override
    public void dispose() {
        if (bridge != null) bridge.stop();
        super.dispose();
    }
}
