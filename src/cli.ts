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

import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { FtpClient } from "./ftp.js";
import { PhpMyAdminClient, StatementError } from "./phpmyadmin.js";
import { AuditLog } from "./audit.js";
import { splitStatements, summarise } from "./sql.js";

const USAGE = `cdmon - deploy files and run SQL on cdmon hosting

Usage:
  cdmon files:list [path]
  cdmon files:read <path>
  cdmon files:upload <local> <remote> [--apply]
  cdmon files:delete <remote> [--apply]
  cdmon db:query <sql>
  cdmon db:execute <file.sql> [--apply]

Writes are a dry run unless --apply is given, and require CDMON_ALLOW_WRITES=1.
Configuration comes from the environment; see .env.example.
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== "--apply");
  const apply = argv.includes("--apply");
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig();
  const audit = new AuditLog(config.auditLog);
  const ftp = config.ftp ? new FtpClient(config.ftp) : null;
  const pma = config.pma ? new PhpMyAdminClient(config.pma) : null;

  const needWrites = () => {
    if (!config.allowWrites) {
      throw new Error("Writes are disabled. Set CDMON_ALLOW_WRITES=1.");
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

    case "files:upload": {
      const local = required(rest[0], "a local file");
      const remote = required(rest[1], "a remote path");
      needWrites();
      const content = await readFile(local, "utf8");
      if (!apply) {
        process.stdout.write(`[dry run] would upload ${content.length} bytes to ${remote}\n`);
        return 0;
      }
      const result = await need(ftp, "FTP").upload(remote, content);
      await audit.record("files:upload", result);
      process.stdout.write(`Uploaded ${result.bytes} bytes to ${result.path}\n`);
      return 0;
    }

    case "files:delete": {
      const remote = required(rest[0], "a remote path");
      needWrites();
      if (!apply) {
        process.stdout.write(`[dry run] would delete ${remote}\n`);
        return 0;
      }
      const result = await need(ftp, "FTP").remove(remote);
      await audit.record("files:delete", result);
      process.stdout.write(`Deleted ${result.path}\n`);
      return 0;
    }

    case "db:query": {
      const sql = required(rest.join(" "), "a SQL statement");
      // query(), never execute(): the read-only refusal is the method, so this command
      // cannot run a statement that writes even if nobody remembers to check here.
      const results = await need(pma, "phpMyAdmin").query(sql);
      printResults(results);
      return 0;
    }

    case "db:execute": {
      const file = required(rest[0], "a .sql file");
      const sql = await readFile(file, "utf8");
      needWrites();

      const statements = splitStatements(sql);
      if (!apply) {
        process.stdout.write(`[dry run] ${statements.length} statement(s) would run:\n`);
        for (const s of statements) process.stdout.write(`  [${s.index}] ${summarise(s.sql, 80)}\n`);
        return 0;
      }

      try {
        const results = await need(pma, "phpMyAdmin").execute(sql);
        await audit.record("db:execute", { file, statements: results.length });
        printResults(results);
        return 0;
      } catch (err) {
        await audit.record("db:execute", { file, error: String(err) }, "failed");
        throw err;
      }
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

// Set the exit code rather than calling process.exit(). When stdout is a pipe rather than a
// terminal, writes to it are asynchronous, and process.exit() discards whatever has not
// flushed yet - so `cdmon files:read big.sql | grep ...` silently lost everything past the
// 64KB pipe buffer and looked like a complete file. Letting the process end on its own drains
// the stream first. This is why a truncated read reported no error: nothing had gone wrong at
// the FTP layer at all.
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
