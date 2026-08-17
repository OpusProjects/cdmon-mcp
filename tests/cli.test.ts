/**
 * Argument parsing, which is small enough to look obviously right and was not.
 *
 * The truncation notice told the reader to "raise --max-rows" while the parser understood
 * only --apply, so the advice named a flag that did not exist. Anything the output tells
 * someone to do has to be something they can actually do.
 */

import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/cli.js";

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
