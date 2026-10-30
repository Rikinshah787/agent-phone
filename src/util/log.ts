/**
 * All progress output goes to stderr. stdout is reserved for the MCP protocol
 * when running as a server, so nothing here may ever write to it.
 */
export function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
