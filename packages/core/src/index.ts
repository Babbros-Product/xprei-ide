// @xprei/core — the platform-neutral heart of xpreiIDE: model adapters + the
// bring-your-own-model contract, the RAG substrate, the inline-edit prompt
// builder, and the full agent brain (protocol, tools, checkpoint, orchestrator).
// No editor/UI dependency — consumed by the VS Code extension and the standalone
// sidecar alike.

// Providers
export * from "./providers/provider";
export * from "./providers/ollama";
export * from "./providers/openai-compat";
export * from "./providers/presets";
export * from "./providers/modelList";

// Context / RAG
export * from "./context/chunking";
export * from "./context/vectorstore";
export * from "./context/retrieval";
export * from "./context/budget";
export * from "./context/mentions";
export * from "./context/exclude";
export * from "./context/urlSafety";
export * from "./context/htmlStrip";
export * from "./context/repomap";
export * from "./context/ignoreFile";
export * from "./config/yamlLite";
export * from "./config/schema";
export * from "./mcp/mcpClient";
export * from "./mcp/mcpManager";
export * from "./providers/fimModels";

// Inline-edit prompt building
export * from "./edit/prompt";

// Agent
export * from "./agent/host";
export * from "./agent/glob";
export * from "./agent/pathResolve";
export * from "./agent/protocol";
export * from "./agent/tools";
export * from "./agent/checkpoint";
export * from "./agent/orchestrator";

// Standalone-sidecar host (Node fs/exec implementation of AgentHost)
export * from "./host/nodeHost";

// Sidecar JSON-RPC server (chat + agent over a transport-agnostic session).
// The stdio entrypoint (./server/stdio) is intentionally NOT re-exported here:
// it has a top-level side effect (auto-start when run directly) that would
// defeat tree-shaking and pull the sidecar into every barrel consumer. Import
// it directly (or run it) instead.
export * from "./server/session";
