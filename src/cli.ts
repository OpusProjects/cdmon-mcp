#!/usr/bin/env node
/**
 * Command line face, over the same core the MCP server uses.
 *
 * CI has no model in it, and a deploy has no judgement call worth making: it should upload
 * exactly what changed, identically, every time. Routing that through an agent would trade
 * determinism for nothing. So the same FTP client, statement splitter and path guard are
 * reachable here without the protocol in between.
 *
 * One difference from the MCP face is deliberate. There, writes default to a dry run
 * because the caller may be a model. Here they default to a dry run too, and `--apply`
 * opts in - a script that meant to deploy will say so, while a mistyped command does
 * nothing.
 */

import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { FtpClient, uploadSize } from "./ftp.js";
import { PhpMyAdminClient, StatementError } from "./phpmyadmin.js";
import { AuditLog } from "./audit.js";
import { splitStatements, summarise } from "./sql.js";

const USAGE = `cdmon - deploy files and run SQL on cdmon hosting

Usage:
  cdmon files:list [path]
  cdmon files:read <path>
  cdmon files:download <remote> <local>
  cdmon files:upload <local> <remote> [--apply]
  cdmon files:delete <remote> [--apply]
  cdmon db:query <sql> [--max-rows N]
  cdmon db:execute <file.sql> [--apply] [--max-rows N]
  cdmon db:dump [file.sql]

Writes are a dry run unless --apply is given. Applying requires CDMON_ALLOW_WRITES=1;
a dry run does not, so a migration can be previewed from a read-only session.

--max-rows defaults to 200. A capped result says how many it held back.
Configuration comes from the environment; see .env.example.
`;

async function main(argv: string[]): Promise<number> {
  const { rest: args, apply, maxRows } = parseFlags(argv);
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig();
  const audit = new AuditLog(config.auditLog);
  const ftp = config.ftp ? new FtpClient(config.ftp) : null;
  const pma = config.pma ? new PhpMyAdminClient(config.pma) : null;

  // Only an --apply calls this. A dry run changes nothing, and refusing to preview a
  // migration until writes are switched on is backwards: previewing is how you decide
  // whether to switch them on.
  const needWrites = () => {
    if (!config.allowWrites) {
      throw new Error(
        "Writes are disabled. Set CDMON_ALLOW_WRITES=1 to apply. Without --apply this " +
          "would have run as a dry run, which needs no permission.",
      );
    }
  };

  switch (command) {
    case "files:list": {
      const entries = await need(ftp, "FTP").list(rest[0] ?? ".");
      for (const e of entries) {
        process.stdout.write(
          `${e.type === "directory" ? "d" : "-"} ${String(e.size).padStart(9)}  ${e.name}\n`,
        );
      }
      return 0;
    }

    case "files:read": {
      const path = required(rest[0], "a remote path");
      process.stdout.write(await need(ftp, "FTP").read(path));
      return 0;
    }

    case "files:download": {
      const remote = required(rest[0], "a remote path");
      const local = required(rest[1], "a local destination");
      const result = await need(ftp, "FTP").download(remote, local);
      // A download changes nothing on the server, but it lands a durable copy of the site's
      // data on disk, which is exactly the kind of thing a record should be able to account
      // for later - the same reason db:dump to a file is recorded.
      await audit.record("files:download", { path: result.path, localPath: result.localPath, bytes: result.bytes });
      process.stdout.write(`Downloaded ${result.bytes} bytes from ${result.path} to ${result.localPath}\n`);
      return 0;
    }

    case "files:upload": {
      const local = required(rest[0], "a local file");
      const remote = required(rest[1], "a remote path");
      const content = await readFile(local, "utf8");
      if (!apply) {
        // Recorded, like the MCP face records its dry runs. An intention that was formed
        // and then not carried out is part of the story the log tells.
        await audit.record("files:upload", { path: remote, bytes: uploadSize(content) }, "dry-run");
        process.stdout.write(`[dry run] would upload ${uploadSize(content)} bytes to ${remote}\n`);
        return 0;
      }
      needWrites();

      // Recorded either way, as db:execute is. A transfer that broke off may have left a
      // partial file behind, and a log that only lists the uploads that succeeded cannot
      // explain a truncated file on the site.
      try {
        const result = await need(ftp, "FTP").upload(remote, content);
        await audit.record("files:upload", result);
        process.stdout.write(`Uploaded ${result.bytes} bytes to ${result.path}\n`);
        return 0;
      } catch (err) {
        await audit.record("files:upload", { path: remote, error: String(err) }, "failed");
        throw err;
      }
    }

    case "files:delete": {
      const remote = required(rest[0], "a remote path");
      if (!apply) {
        await audit.record("files:delete", { path: remote }, "dry-run");
        process.stdout.write(`[dry run] would delete ${remote}\n`);
        return 0;
      }
      needWrites();

      try {
        const result = await need(ftp, "FTP").remove(remote);
        await audit.record("files:delete", result);
        process.stdout.write(`Deleted ${result.path}\n`);
        return 0;
      } catch (err) {
        await audit.record("files:delete", { path: remote, error: String(err) }, "failed");
        throw err;
      }
    }

    case "db:query": {
      const sql = required(rest.join(" "), "a SQL statement");
      // query(), never execute(): the read-only refusal is the method, so this command
      // cannot run a statement that writes even if nobody remembers to check here.
      const results = await need(pma, "phpMyAdmin").query(sql, maxRows);
      printResults(results);
      return 0;
    }

    case "db:execute": {
      const file = required(rest[0], "a .sql file");
      const sql = await readFile(file, "utf8");

      const statements = splitStatements(sql);
      if (!apply) {
        await audit.record("db:execute", { file, statements: statements.length }, "dry-run");
        process.stdout.write(`[dry run] ${statements.length} statement(s) would run:\n`);
        for (const s of statements) process.stdout.write(`  [${s.index}] ${summarise(s.sql, 80)}\n`);
        return 0;
      }
      needWrites();

      try {
        const results = await need(pma, "phpMyAdmin").execute(sql, maxRows);
        await audit.record("db:execute", { file, statements: results.length });
        printResults(results);
        return 0;
      } catch (err) {
        await audit.record("db:execute", { file, error: String(err) }, "failed");
        throw err;
      }
    }

    case "db:dump": {
      const sql = await need(pma, "phpMyAdmin").dump();
      const out = rest[0];
      if (out) {
        await writeFile(out, sql, "utf8");
        // A dump only means anything once it is somewhere durable, so the file it landed in
        // is worth recording even though the export changed nothing on the server.
        await audit.record("db:dump", { file: out, bytes: Buffer.byteLength(sql, "utf8") });
        process.stdout.write(`Dumped ${Buffer.byteLength(sql, "utf8")} bytes to ${out}\n`);
      } else {
        process.stdout.write(sql);
      }
      return 0;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function printResults(results: Awaited<ReturnType<PhpMyAdminClient["execute"]>>): void {
  for (const r of results) {
    process.stdout.write(`[${r.index}] ${summarise(r.sql)}\n`);
    if (r.affectedRows !== null) {
      process.stdout.write(`    ${r.affectedRows} row(s) affected\n`);
    } else if (r.rows.length === 0) {
      process.stdout.write("    no rows\n");
    } else {
      for (const cells of r.rows) process.stdout.write(`    ${cells.join(" | ")}\n`);
      if (r.truncated) {
        process.stdout.write(
          `    ... ${(r.totalRows ?? 0) - r.rows.length} more held back; raise --max-rows\n`,
        );
      }
    }
  }
}

/**
 * Separate flags from positional arguments.
 *
 * Exported for testing. `--max-rows` exists because the truncation notice used to tell the
 * reader to raise it while the CLI parsed only `--apply` - advice that could not be followed.
 *
 * @param argv Raw arguments, without the node and script entries.
 * @throws Error if --max-rows is given without a usable number.
 */
export function parseFlags(argv: string[]): { rest: string[]; apply: boolean; maxRows: number } {
  const rest: string[] = [];
  let apply = false;
  let maxRows = 200;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--max-rows") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-rows needs a whole number of at least 1.");
      }
      maxRows = value;
    } else if (arg.startsWith("--max-rows=")) {
      const value = Number(arg.slice("--max-rows=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-rows needs a whole number of at least 1.");
      }
      maxRows = value;
    } else {
      rest.push(arg);
    }
  }

  return { rest, apply, maxRows };
}

function need<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`${label} is not configured. See .env.example.`);
  }
  return value;
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Expected ${what}.`);
  return value;
}

/**
 * Is this module the command that was run, rather than something that was imported?
 *
 * Both sides are resolved through the filesystem before comparing. Node resolves the entry
 * point's symlinks before loading it, so `import.meta.url` names the real file - while
 * `process.argv[1]` is the path as typed, which through the `bin` link npm installs is
 * `.../node_modules/.bin/cdmon`. Comparing the two as strings therefore never matched from an
 * installed command: `cdmon --help` printed nothing and exited 0, and a deploy step in CI ran
 * no command at all while reporting success. A path that cannot be resolved is not this module.
 *
 * Exported for testing.
 *
 * @param moduleUrl `import.meta.url` of the module asking.
 * @param argv1     `process.argv[1]`, the script Node was told to run, if any.
 */
export function isInvokedDirectly(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// Run only when invoked as a command, not when imported. Without this, importing anything
// from here - as the tests do, to reach parseFlags - executes a command as a side effect of
// the import, which at best prints usage and at worst acts on a live site.
if (isInvokedDirectly(import.meta.url, process.argv[1])) {
  // Set the exit code rather than calling process.exit(). When stdout is a pipe rather than a
  // terminal, writes to it are asynchronous, and process.exit() discards whatever has not
  // flushed yet - so `cdmon files:read big.sql | grep ...` silently lost everything past the
  // 64KB pipe buffer and looked like a complete file. Letting the process end on its own
  // drains the stream first. That is why a truncated read reported no error: nothing had gone
  // wrong at the FTP layer at all.
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // A failed statement already carries which one and how many applied; printing the
      // stack on top of that buries the part the operator needs.
      process.stderr.write(err instanceof StatementError ? `${err.message}\n` : `${String(err)}\n`);
      process.exitCode = 1;
    });
}
