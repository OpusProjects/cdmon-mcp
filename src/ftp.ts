/**
 * FTP client for cdmon hosting, with the two pieces of operational knowledge that keep it
 * usable built in rather than left to the caller: a rate limit, and a path guard.
 *
 * Neither belongs in documentation. cdmon blocks an address that connects too quickly, and
 * an agent asked to "upload the changed files" will issue twenty operations without pause,
 * so the delay lives in the queue below. And the caller composing paths may be a language
 * model, so the guard treats every path as untrusted.
 */

import { Client, type FileInfo } from "basic-ftp";
import path from "node:path";
import { Readable } from "node:stream";
import type { FtpConfig } from "./config.js";

/** Raised when a requested path cannot be placed inside the configured root. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Resolve a caller-supplied path against the root, refusing anything that escapes it.
 *
 * This is the guard whose failure is unrecoverable rather than annoying. Everything else
 * in this file fails loudly - a login breaks, a transfer errors. A weakened check here
 * throws nothing at all; it quietly permits a write or a delete somewhere it should never
 * have reached. On shared hosting an FTP account often has reach above the document root,
 * so "outside the root" can mean another site entirely.
 *
 * Exported so it can be tested directly, without a connection.
 *
 * @param root      Remote directory every operation is confined to.
 * @param requested Path from the caller, expected to be relative to that root.
 * @returns         The joined, normalised path, safe to hand to the server.
 * @throws PathError if the path is empty, absolute, or resolves outside the root.
 */
export function resolveInsideRoot(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new PathError("a path is required");
  }

  // Backslashes first: some servers accept them as separators, so leaving them alone
  // would let "..\\.." past a check that only understands forward slashes.
  const candidate = requested.replace(/\\/g, "/").trim();

  if (candidate.startsWith("/")) {
    throw new PathError(`absolute paths are refused: "${requested}"`);
  }

  // A null byte truncates the path in some C-based servers, so the name acted on there
  // can differ from the one checked here.
  if (candidate.includes("\0")) {
    throw new PathError("paths may not contain null bytes");
  }

  // Normalise the relative path on its own, before it touches the root. Searching for a
  // literal ".." would miss "a/../../b", which escapes while containing no leading one.
  //
  // Doing this first rather than after joining also covers a root of "/": posix
  // normalisation clamps "/../x" back to "/x", so joining first would turn a traversal into
  // a valid path silently, acting on a file the caller never named.
  const relative = path.posix.normalize(candidate);
  if (relative === ".." || relative.startsWith("../")) {
    throw new PathError(`"${requested}" resolves outside the configured root`);
  }

  const base = normaliseRoot(root);
  const full = path.posix.normalize(path.posix.join(base, relative));

  // Belt and braces. The check above is the one that catches escape; this one holds if
  // some future edit changes how the two are combined.
  if (!isInside(base, full)) {
    throw new PathError(`"${requested}" resolves outside the configured root`);
  }

  return full;
}

/**
 * Is `full` the root itself, or something beneath it?
 *
 * The trailing separator matters: without it a root of "/site/web" would also accept
 * "/site/web-backup", a different directory that merely shares a prefix.
 */
export function isInside(root: string, full: string): boolean {
  const base = normaliseRoot(root);
  if (full === base) return true;
  const withSep = base.endsWith("/") ? base : `${base}/`;
  return full.startsWith(withSep);
}

/** Collapse a root to a normalised form with no trailing slash, except for "/" itself. */
function normaliseRoot(root: string): string {
  const cleaned = path.posix.normalize((root || "/").replace(/\\/g, "/"));
  if (cleaned === "/") return "/";
  return cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
}

/**
 * A limitation worth stating rather than discovering.
 *
 * FTP is remote, so there is no realpath() and no way to resolve symlinks. The guard above
 * is purely lexical: a symlink placed on the server can still lead somewhere unintended,
 * and nothing here can see it. Local file APIs can do better; this cannot.
 */
export const SYMLINKS_ARE_NOT_RESOLVED = true;

/** One entry from a directory listing, reduced to what a caller actually needs. */
export interface RemoteEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size: number;
  modifiedAt: string | null;
}

/**
 * Serialised, rate-limited FTP client.
 *
 * Every operation goes through a single promise chain, so two tool calls cannot open
 * competing connections, and each is followed by a delay. The delay applies after failures
 * too: a burst of errors is exactly the pattern that gets an address blocked.
 */
export class FtpClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: FtpConfig) {}

  /** List a directory, relative to the configured root. */
  async list(remoteDir = "."): Promise<RemoteEntry[]> {
    const target = resolveInsideRoot(this.cfg.root, remoteDir);
    return this.withClient(async (client) => {
      const entries = await client.list(target);
      return entries.map(toRemoteEntry);
    });
  }

  /** Read a remote file as text. Intended for small files: config, templates, logs. */
  async read(remoteFile: string, maxBytes = 256 * 1024): Promise<string> {
    const target = resolveInsideRoot(this.cfg.root, remoteFile);
    return this.withClient(async (client) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const sink = new (await import("node:stream")).Writable({
        write(chunk, _enc, cb) {
          total += chunk.length;
          // Refuse rather than truncate: half a file read as if whole is worse than an
          // error, because the caller cannot tell the difference.
          if (total > maxBytes) return cb(new Error(`file exceeds ${maxBytes} bytes`));
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await client.downloadTo(sink, target);
      return Buffer.concat(chunks).toString("utf8");
    });
  }

  /** Upload text content, creating parent directories as needed. */
  async upload(remoteFile: string, content: string): Promise<{ path: string; bytes: number }> {
    const target = resolveInsideRoot(this.cfg.root, remoteFile);
    return this.withClient(async (client) => {
      const dir = path.posix.dirname(target);
      if (dir && dir !== "/" && dir !== ".") await client.ensureDir(dir);
      const bytes = Buffer.byteLength(content, "utf8");
      await client.uploadFrom(Readable.from([content]), target);
      return { path: target, bytes };
    });
  }

  /** Delete a remote file. */
  async remove(remoteFile: string): Promise<{ path: string }> {
    const target = resolveInsideRoot(this.cfg.root, remoteFile);
    return this.withClient(async (client) => {
      await client.remove(target);
      return { path: target };
    });
  }

  /**
   * Run one operation with a fresh connection, serialised behind everything queued before.
   *
   * A connection per operation rather than a pooled one: these tools are used in bursts
   * minutes apart, and a socket left open across an idle period is dropped by the server
   * anyway, producing errors that look like failures of the operation rather than of the
   * connection.
   */
  private withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const client = new Client(this.cfg.timeoutMs);
      client.ftp.verbose = false;
      try {
        await client.access({
          host: this.cfg.host,
          user: this.cfg.user,
          password: this.cfg.password,
          secure: this.cfg.secure,
        });
        return await fn(client);
      } finally {
        client.close();
      }
    });

    // Pause after every operation, successful or not, before the next one starts.
    this.queue = run.then(
      () => sleep(this.cfg.delayMs),
      () => sleep(this.cfg.delayMs),
    );

    return run;
  }
}

function toRemoteEntry(info: FileInfo): RemoteEntry {
  const type =
    info.isDirectory ? "directory" : info.isSymbolicLink ? "symlink" : info.isFile ? "file" : "unknown";
  return {
    name: info.name,
    type,
    size: info.size,
    modifiedAt: info.modifiedAt ? info.modifiedAt.toISOString() : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
