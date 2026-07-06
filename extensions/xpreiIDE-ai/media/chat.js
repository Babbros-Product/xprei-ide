// @ts-check
// Webview UI script. Renders messages and streams assistant deltas.
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById("messages"));
  const form = /** @type {HTMLFormElement} */ (document.getElementById("composer"));
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("input"));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("sendBtn"));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stopBtn"));
  const resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById("resetBtn"));
  const agentChk = /** @type {HTMLInputElement} */ (document.getElementById("agentChk"));

  let streamingEl = null;
  let busy = false;

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    stopBtn.disabled = !value;
  }

  function submit() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    const agent = agentChk.checked;
    addMessage("user", text);
    input.value = "";
    setBusy(true);
    vscode.postMessage({ type: "send", text, agent });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  resetBtn.addEventListener("click", () => {
    messagesEl.innerHTML = "";
    vscode.postMessage({ type: "reset" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "restore":
        addMessage(msg.role, msg.text);
        break;
      case "info":
        addMessage("info", msg.text);
        break;
      case "start":
        streamingEl = addMessage("assistant", "");
        break;
      case "delta":
        if (streamingEl) {
          streamingEl.textContent += msg.text;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        break;
      case "done":
        streamingEl = null;
        setBusy(false);
        break;
      case "error":
        addMessage("error", msg.text);
        streamingEl = null;
        setBusy(false);
        break;
      case "agent":
        handleAgent(msg);
        break;
    }
  });

  // Render one agent-loop event as a labeled transcript entry.
  function handleAgent(msg) {
    switch (msg.kind) {
      case "start":
        addMessage("agent-step", "Agent started.");
        break;
      case "step":
        addMessage("agent-step", "Step " + msg.n);
        break;
      case "thought":
        addMessage("agent-thought", msg.text);
        break;
      case "tool":
        addMessage("agent-tool", "› " + msg.name + ": " + msg.text);
        break;
      case "observation":
        addMessage("agent-obs", msg.text);
        break;
      case "final":
        addMessage("assistant", msg.text);
        break;
      case "error":
        addMessage("error", msg.text);
        break;
      case "end":
        setBusy(false);
        break;
    }
  }

  // Ask the extension to replay history — covers reload after the panel was
  // hidden or the dev host restarted.
  vscode.postMessage({ type: "ready" });
})();
