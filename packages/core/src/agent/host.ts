// AgentHost — the seam between agent tools and the environment. Tools call this
// interface, never platform/fs APIs directly, so the tool layer is unit-testable
// with a fake host. Each host app supplies its own implementation: VS Code binds
// it to workspace.fs; the standalone sidecar binds it to Node's fs/child_process.

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface AgentHost {
  readonly cwd: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  grep(query: string, path?: string): Promise<GrepHit[]>;
  exec(command: string): Promise<ExecResult>;
}
