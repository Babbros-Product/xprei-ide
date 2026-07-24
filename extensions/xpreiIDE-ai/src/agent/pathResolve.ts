// Pure path resolution for agent tool calls. Kept vscode-free so it's unit
// testable; VscodeAgentHost.resolve() is a thin wrapper around this.
//
// Models occasionally hand back an absolute path (sometimes with backslashes
// on Windows) instead of one relative to the workspace root. Naively joining
// that onto the root with vscode.Uri.joinPath treats the whole absolute path
// as one literal segment, producing a corrupted path like "d:\test\d:\test\..."
// instead of a clean error the model could recover from. Detect and either
// rebase it onto the root (if it already points inside the workspace) or
// reject it with a message a small model can act on.

const DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

export interface ResolvedPath {
  relPath: string;
}

export interface ResolveError {
  error: string;
}

export function resolveWorkspacePath(rootFsPath: string, rawPath: string): ResolvedPath | ResolveError {
  const normalizedRoot = rootFsPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedInput = rawPath.replace(/\\/g, "/");

  const isAbsolute = normalizedInput.startsWith("/") || DRIVE_ABSOLUTE.test(rawPath);
  if (!isAbsolute) {
    return { relPath: normalizedInput.replace(/^\.\//, "") };
  }

  const rootLower = normalizedRoot.toLowerCase();
  const inputLower = normalizedInput.toLowerCase();
  if (inputLower === rootLower || inputLower.startsWith(rootLower + "/")) {
    const rel = normalizedInput.slice(normalizedRoot.length).replace(/^\/+/, "");
    return { relPath: rel };
  }

  return {
    error:
      `'path' must be relative to the workspace root (${rootFsPath}), e.g. "src/App.ts" — ` +
      `got an absolute path outside it: "${rawPath}".`,
  };
}
