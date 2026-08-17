/**
 * The audit log, and specifically what it refuses to write down.
 *
 * This file is meant to be kept, grepped and shared. A password that reached it because a
 * caller passed one by mistake would live there indefinitely, in a file whose whole purpose
 * is to be handed to someone else.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cdmon-audit-"));
  file = path.join(dir, "audit.log");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async () =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("AuditLog", () => {
  it("writes one JSON object per line, so the file stays greppable", async () => {
    const log = new AuditLog(file);
    await log.record("files_upload", { path: "a.txt", bytes: 3 });
    await log.record("files_delete", { path: "b.txt" });

    const entries = await lines();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe("files_upload");
    expect(entries[0].detail.path).toBe("a.txt");
  });

  it("records the outcome, including a dry run that changed nothing", async () => {
    const log = new AuditLog(file);
    await log.record("files_upload", { path: "a" }, "dry-run");
    await log.record("db_execute", { error: "boom" }, "failed");
    await log.record("files_delete", { path: "b" });

    expect((await lines()).map((e) => e.outcome)).toEqual(["dry-run", "failed", "ok"]);
  });

  it("timestamps every entry", async () => {
    const log = new AuditLog(file);
    await log.record("files_upload", { path: "a" });
    expect((await lines())[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("redacts anything whose key looks like a credential", async () => {
    const log = new AuditLog(file);
    await log.record("probe", {
      password: "hunter2",
      PASSWORD: "hunter2",
      apiKey: "abcd",
      csrf_token: "xyz",
      client_secret: "shh",
      path: "keep/me.txt",
    });

    const raw = await readFile(file, "utf8");
    for (const secret of ["hunter2", "abcd", "xyz", "shh"]) {
      expect(raw).not.toContain(secret);
    }

    const entry = (await lines())[0];
    expect(entry.detail.password).toBe("[redacted]");
    expect(entry.detail.apiKey).toBe("[redacted]");
    // Non-credential keys survive, or the log would record nothing worth keeping.
    expect(entry.detail.path).toBe("keep/me.txt");
  });

  it("appends rather than replacing, across separate instances", async () => {
    // Each CLI invocation constructs its own AuditLog. If the second truncated the file,
    // the record would only ever hold the last command run.
    await new AuditLog(file).record("first", {});
    await new AuditLog(file).record("second", {});
    expect((await lines()).map((e) => e.tool)).toEqual(["first", "second"]);
  });

  it("does not throw when the log cannot be written", async () => {
    // A full disk or a read-only directory must not turn a successful deploy into a
    // reported failure: the work already happened, and claiming otherwise sends the
    // operator looking for a problem that does not exist.
    const log = new AuditLog(path.join(dir, "no", "such", "dir", "audit.log"));
    await expect(log.record("files_upload", { path: "a" })).resolves.toBeUndefined();
  });
});
