// Pure SSRF-safety checks for the @url context provider. No network I/O,
// no vscode dependency — the caller (contextEngine.ts) resolves a
// hostname to its IP address(es) via DNS and passes each one to
// isBlockedAddress(); this module only judges values it's handed. Blocks
// exactly the ranges reviewed in the design spec — private/loopback/
// link-local IPv4 and IPv6 — as a baseline against the realistic SSRF
// attack shape (localhost, LAN services, cloud-metadata endpoints), not
// an exhaustive enterprise-grade IP-range database.

export function isSafeUrl(parsed: URL): boolean {
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function isBlockedAddress(address: string): boolean {
  const lower = address.toLowerCase();

  if (lower.includes(":")) {
    if (lower === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
