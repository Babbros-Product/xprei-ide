// @ts-check
// Host transport shim. chat.js talks to exactly one thing — `window.xprei` —
// so the same chat UI runs unmodified inside VS Code's webview, a JetBrains
// JCEF browser, or an Eclipse SWT Browser. This file is the only place that
// knows which host it's running in.
//
// Contract: window.xprei = { postMessage(msg), onMessage(callback) }
//   - postMessage(msg): send a plain-object message to the host.
//   - onMessage(cb): cb(msg) is called for every message the host sends down.
//
// VS Code: native acquireVsCodeApi() + the standard "message" window event —
// used as-is, unchanged from before this shim existed.
//
// JetBrains (JCEF) and Eclipse (SWT Browser) both implement ONE shared native
// contract instead of two bespoke ones, so a plugin author only needs to wire:
//   - inject `window.xpreiHostBridge = { postMessage(jsonString) { ... } }`
//     (JBCefJSQuery.inject() for JetBrains; a registered BrowserFunction for
//     Eclipse) that forwards the JSON string to the native side.
//   - push inbound messages by calling `window.__xpreiReceive(jsonStringOrObj)`
//     from native code (browser.execute(...) / cefBrowser.executeJavaScript(...)).
(function () {
  /** @type {((msg: any) => void)[]} */
  const listeners = [];

  function dispatch(msg) {
    for (const cb of listeners) cb(msg);
  }

  if (typeof acquireVsCodeApi === "function") {
    const vscode = acquireVsCodeApi();
    window.addEventListener("message", (event) => dispatch(event.data));
    window.xprei = {
      postMessage: (msg) => vscode.postMessage(msg),
      onMessage: (cb) => listeners.push(cb),
    };
    return;
  }

  // JetBrains / Eclipse: a native-injected `xpreiHostBridge.postMessage` plus
  // a global `__xpreiReceive` the native side calls to push messages down.
  window.__xpreiReceive = (msg) => dispatch(typeof msg === "string" ? JSON.parse(msg) : msg);
  window.xprei = {
    postMessage: (msg) => {
      if (!window.xpreiHostBridge) {
        console.error("xpreiIDE: no host bridge available (window.xpreiHostBridge is unset).");
        return;
      }
      window.xpreiHostBridge.postMessage(JSON.stringify(msg));
    },
    onMessage: (cb) => listeners.push(cb),
  };
})();
