#!/usr/bin/env node
/**
 * MCP entry point: transport, tool registration, and the write gate.
 *
 * Tools are defined here rather than in their own directory. The whole surface an agent can
 * reach fits on one screen, which is worth more than the tidiness of splitting it: the
 * question this file answers is "what can this thing do to my site?", and that should not
 * require opening three files to establish.
 *
 * Reads are always available. Writes require CDMON_ALLOW_WRITES, and every write tool
 * defaults to a dry run, because the caller is a language model and the blast radius is a
 * production site.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { FtpClient, uploadSize } from "./ftp.js";
import { PhpMyAdminClient } from "./phpmyadmin.js";
import { AuditLog } from "./audit.js";
import { splitStatements, summarise } from "./sql.js";

const config = loadConfig();
const audit = new AuditLog(config.auditLog);
const ftp = config.ftp ? new FtpClient(config.ftp) : null;
const pma = config.pma ? new PhpMyAdminClient(config.pma) : null;

const server = new McpServer({ name: "cdmon-mcp", version: "0.2.1" });

/**
 * Refuse a write when the operator has not opted in.
 *
 * Called only once a tool is about to act for real. A dry run changes nothing, and letting it
 * run read-only is what allows an agent to say what it *would* do before anyone decides
 * whether to enable writing at all. The CLI gates its own `--apply` at the same point.
 */
function requireWrites(): void {
  if (!config.allowWrites) {
    throw new Error(
      "Writes are disabled. Set CDMON_ALLOW_WRITES=1 to enable uploads, deletes and " +
        "data-changing SQL. This server starts read-only on purpose. Calling this tool " +
        "with dryRun true reports what would happen and needs no permission.",
    );
  }
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/* ------------------------------------------------------------------ files */

if (ftp) {
  server.registerTool(
    "files_list",
    {
      description: "List a directory on the site, relative to the configured root.",
      inputSchema: { path: z.string().default(".").describe("Directory, relative to the root") },
    },
    async ({ path }) => {
      const entries = await ftp.list(path);
      const body = entries
        .map((e) => `${e.type === "directory" ? "d" : "-"} ${String(e.size).padStart(9)}  ${e.name}`)
        .join("\n");
      return text(body || "(empty directory)");
    },
  );

  server.registerTool(
    "files_read",
    {
      description: "Read a small text file from the site.",
      inputSchema: { path: z.string().describe("File, relative to the root") },
    },
    async ({ path }) => text(await ftp.read(path)),
  );

  server.registerTool(
    "files_upload",
    {
      description:
        "Upload text content to the site, creating parent directories. Writes only when " +
        "dryRun is false and CDMON_ALLOW_WRITES is set.",
      inputSchema: {
        path: z.string().describe("Destination, relative to the root"),
        content: z.string().describe("File contents"),
        dryRun: z.boolean().default(true).describe("Report what would happen without doing it"),
      },
    },
    async ({ path, content, dryRun }) => {
      if (dryRun) {
        await audit.record("files_upload", { path, bytes: uploadSize(content) }, "dry-run");
        return text(`[dry run] would upload ${uploadSize(content)} bytes to ${path}`);
      }
      requireWrites();

      // Recorded either way, as db_execute is. A transfer that broke off may have left a
      // partial file behind, and a log that only lists the uploads that succeeded cannot
      // explain a truncated file on the site.
      try {
        const result = await ftp.upload(path, content);
        await audit.record("files_upload", result);
        return text(`Uploaded ${result.bytes} bytes to ${result.path}`);
      } catch (err) {
        await audit.record("files_upload", { path, error: String(err) }, "failed");
        throw err;
      }
    },
  );

  server.registerTool(
    "files_delete",
    {
      description:
        "Delete a file from the site. Writes only when dryRun is false and " +
        "CDMON_ALLOW_WRITES is set.",
      inputSchema: {
        path: z.string().describe("File to delete, relative to the root"),
        dryRun: z.boolean().default(true).describe("Report what would happen without doing it"),
      },
    },
    async ({ path, dryRun }) => {
      if (dryRun) {
        await audit.record("files_delete", { path }, "dry-run");
        return text(`[dry run] would delete ${path}`);
      }
      requireWrites();

      try {
        const result = await ftp.remove(path);
        await audit.record("files_delete", result);
        return text(`Deleted ${result.path}`);
      } catch (err) {
        await audit.record("files_delete", { path, error: String(err) }, "failed");
        throw err;
      }
    },
  );
}

/* --------------------------------------------------------------- database */

if (pma) {
  server.registerTool(
    "db_query",
    {
      description:
        "Run a read-only query (SELECT, SHOW, DESCRIBE, EXPLAIN). Anything that changes " +
        "data is refused here; use db_execute.",
      inputSchema: {
        sql: z.string().describe("A single read-only statement"),
        maxRows: z.number().int().min(1).max(1000).default(200),
      },
    },
    async ({ sql, maxRows }) => {
      // query(), not execute(): the refusal lives in the method, so this face and the CLI
      // enforce it identically and neither can drift from the other.
      const results = await pma.query(sql, maxRows);
      return text(formatResults(results));
    },
  );

  server.registerTool(
    "db_execute",
    {
      description:
        "Run SQL that changes data or schema, one statement per request, reporting each. " +
        "Writes only when dryRun is false and CDMON_ALLOW_WRITES is set.",
      inputSchema: {
        sql: z.string().describe("One or more statements"),
        dryRun: z.boolean().default(true).describe("List the statements without running them"),
        maxRows: z.number().int().min(1).max(1000).default(200),
      },
    },
    async ({ sql, dryRun, maxRows }) => {
      const statements = splitStatements(sql);

      if (dryRun) {
        await audit.record("db_execute", { statements: statements.length }, "dry-run");
        const listing = statements.map((s) => `  [${s.index}] ${summarise(s.sql, 80)}`).join("\n");
        return text(`[dry run] ${statements.length} statement(s) would run:\n${listing}`);
      }
      requireWrites();

      try {
        const results = await pma.execute(sql, maxRows);
        await audit.record("db_execute", { statements: results.length });
        return text(formatResults(results));
      } catch (err) {
        await audit.record("db_execute", { error: String(err) }, "failed");
        throw err;
      }
    },
  );

  server.registerTool(
    "db_dump",
    {
      description:
        "Export the whole database as SQL — schema and data, every table. Read-only, so it " +
        "needs no write permission. Take this before running a migration.",
      inputSchema: {},
    },
    async () => {
      const sql = await pma.dump();
      return text(sql);
    },
  );
}

/** One line per statement, so a partial application is visible at a glance. */
function formatResults(results: Array<{ index: number; sql: string; affectedRows: number | null; rows: string[][]; totalRows: number | null; truncated: boolean }>): string {
  return results
    .map((r) => {
      const head = `[${r.index}] ${summarise(r.sql)}`;
      if (r.affectedRows !== null) return `${head}\n    ${r.affectedRows} row(s) affected`;
      if (r.rows.length === 0) return `${head}\n    no rows`;
      const shown = r.rows.map((cells) => `    ${cells.join(" | ")}`).join("\n");
      const note = r.truncated ? `\n    ... ${(r.totalRows ?? 0) - r.rows.length} more held back; raise maxRows` : "";
      return `${head}\n${shown}${note}`;
    })
    .join("\n\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);
