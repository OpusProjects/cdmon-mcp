/**
 * An append-only record of everything this server changed.
 *
 * When someone asks what happened to a site, the answer should not be a chat transcript.
 * Transcripts are lossy, easy to lose, and absent entirely when the CLI was driven from a
 * script. A line per write, on disk, is what makes "which upload replaced this file?"
 * answerable.
 *
 * Recorded: anything that changes the server, and anything that lands a durable copy of its
 * data on disk - an upload, a delete, a data-changing statement, a database dump to a file, a
 * download. A transient read that only returns to the caller (a query, reading a file to
 * stdout) is not; logging those would bury the entries that matter in noise, and they leave
 * nothing behind to reconstruct.
 */

import { appendFile } from "node:fs/promises";

/** One recorded action. Kept flat so the file stays greppable. */
export interface AuditEntry {
  at: string;
  tool: string;
  detail: Record<string, unknown>;
  outcome: "ok" | "failed" | "dry-run";
}

export class AuditLog {
  constructor(private readonly file: string) {}

  /**
   * Append one entry.
   *
   * Failures here are swallowed on purpose. A full disk or a read-only directory should not
   * turn a successful deploy into a reported failure - the work already happened, and
   * claiming otherwise would send the operator looking for a problem that does not exist.
   * The warning goes to stderr, which the MCP transport leaves alone.
   */
  async record(tool: string, detail: Record<string, unknown>, outcome: AuditEntry["outcome"] = "ok"): Promise<void> {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      tool,
      detail: redact(detail),
      outcome,
    };

    try {
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      process.stderr.write(`cdmon-mcp: could not write audit log (${String(err)})\n`);
    }
  }
}

/**
 * Strip anything that should not be written to a file that outlives the session.
 *
 * The audit log is meant to be readable, shareable and kept. A password captured in it
 * because a caller passed one by mistake would live there indefinitely.
 */
function redact(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = /pass|secret|token|key/i.test(key) ? "[redacted]" : value;
  }
  return out;
}
