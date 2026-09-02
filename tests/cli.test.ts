/**
 * Argument parsing, which is small enough to look obviously right and was not.
 *
 * The truncation notice told the reader to "raise --max-rows" while the parser understood
 * only --apply, so the advice named a flag that did not exist. Anything the output tells
 * someone to do has to be something they can actually do.
 */

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInvokedDirectly, parseFlags } from "../src/cli.js";

describe("parseFlags", () => {
  it("keeps positional arguments in order", () => {
    const { rest } = parseFlags(["files:upload", "local.txt", "remote.txt"]);
    expect(rest).toEqual(["files:upload", "local.txt", "remote.txt"]);
  });

  it("recognises --apply and removes it from the positionals", () => {
    const { rest, apply } = parseFlags(["files:delete", "a.txt", "--apply"]);
    expect(apply).toBe(true);
    expect(rest).toEqual(["files:delete", "a.txt"]);
  });

  it("defaults to not applying", () => {
    expect(parseFlags(["files:delete", "a.txt"]).apply).toBe(false);
  });

  it("defaults maxRows to the documented 200", () => {
    expect(parseFlags(["db:query", "SELECT 1"]).maxRows).toBe(200);
  });

  it("accepts --max-rows in both spellings", () => {
    expect(parseFlags(["db:query", "SELECT 1", "--max-rows", "500"]).maxRows).toBe(500);
    expect(parseFlags(["db:query", "SELECT 1", "--max-rows=500"]).maxRows).toBe(500);
  });

  it("does not leave the flag's value among the positionals", () => {
    // Otherwise "500" would be read as part of the SQL.
    const { rest } = parseFlags(["db:query", "SELECT 1", "--max-rows", "500"]);
    expect(rest).toEqual(["db:query", "SELECT 1"]);
  });

  it("refuses a value that is not a usable count", () => {
    for (const bad of ["0", "-5", "abc", "1.5"]) {
      expect(() => parseFlags(["db:query", "SELECT 1", "--max-rows", bad])).toThrow(/whole number/);
    }
    expect(() => parseFlags(["db:query", "SELECT 1", "--max-rows"])).toThrow(/whole number/);
  });

  it("handles both flags together, in either order", () => {
    for (const argv of [
      ["db:execute", "m.sql", "--apply", "--max-rows", "50"],
      ["db:execute", "m.sql", "--max-rows", "50", "--apply"],
    ]) {
      const parsed = parseFlags(argv);
      expect(parsed.apply).toBe(true);
      expect(parsed.maxRows).toBe(50);
      expect(parsed.rest).toEqual(["db:execute", "m.sql"]);
    }
  });
});

describe("isInvokedDirectly", () => {
  /**
   * The guard that decides whether importing this module runs a command.
   *
   * It has to be right in both directions. Too loose and `import { parseFlags }` prints usage
   * or acts on a live site; too strict and the installed command does nothing at all - which
   * is what happened through the `bin` link npm creates, because Node resolves the link before
   * loading the entry point while `process.argv[1]` still names the link.
   */
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cdmon-cli-"));
    await writeFile(path.join(dir, "cli.js"), "");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("recognises the script Node was given", () => {
    const real = path.join(dir, "cli.js");
    expect(isInvokedDirectly(pathToFileURL(real).href, real)).toBe(true);
  });

  it("recognises the script when it was reached through a symlink", async () => {
    // The shape `npm link` and `npm install -g` produce: a link in a bin directory pointing at
    // the real file. The module URL names the target; argv[1] names the link.
    const real = path.join(dir, "cli.js");
    const link = path.join(dir, "cdmon");
    await symlink(real, link);
    expect(isInvokedDirectly(pathToFileURL(real).href, link)).toBe(true);
  });

  it("does not fire when the module was merely imported", async () => {
    const real = path.join(dir, "cli.js");
    const other = path.join(dir, "other.js");
    await writeFile(other, "");
    expect(isInvokedDirectly(pathToFileURL(real).href, other)).toBe(false);
  });

  it("does not fire without a script argument, or with one that does not exist", () => {
    const real = path.join(dir, "cli.js");
    expect(isInvokedDirectly(pathToFileURL(real).href, undefined)).toBe(false);
    expect(isInvokedDirectly(pathToFileURL(real).href, path.join(dir, "missing.js"))).toBe(false);
  });
});
