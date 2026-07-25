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
export * from "./context/mentions";
export * from "./context/exclude";

// Inline-edit prompt building
export * from "./edit/prompt";

// Agent
export * from "./agent/host";
export * from "./agent/pathResolve";
export * from "./agent/protocol";
export * from "./agent/tools";
export * from "./agent/checkpoint";
export * from "./agent/orchestrator";
