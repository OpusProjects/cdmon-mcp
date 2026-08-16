/**
 * The splitter is the piece whose failure is silent and destructive: a bad split does not
 * throw, it sends malformed SQL that may partially apply. So it gets the most tests, and
 * they run with no network, no credentials and no container.
 */

import { describe, expect, it } from "vitest";
import {
  hasExecutableSql,
  isReadOnly,
  splitStatements,
  summarise,
  usesTransactionControl,
} from "../src/sql.js";

const sqlOf = (input: string) => splitStatements(input).map((s) => s.sql);

describe("splitStatements", () => {
  it("splits on semicolons between statements", () => {
    expect(sqlOf("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a trailing statement that has no semicolon", () => {
    expect(sqlOf("SELECT 1;\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores a semicolon inside a single-quoted string", () => {
    const out = sqlOf("INSERT INTO t VALUES ('a; b'); SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a; b'");
  });

  it("handles a doubled quote as an escape, not a terminator", () => {
    // "it''s" is one string. Reading the second quote as the end would split mid-value.
    const out = sqlOf("INSERT INTO t VALUES ('it''s; fine'); SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("it''s; fine");
  });

  it("handles a backslash escape inside a string", () => {
    const out = sqlOf(`INSERT INTO t VALUES ('a\\'; b'); SELECT 1;`);
    expect(out).toHaveLength(2);
  });

  it("ignores a semicolon inside a double-quoted string", () => {
    const out = sqlOf('INSERT INTO t VALUES ("a; b"); SELECT 1;');
    expect(out).toHaveLength(2);
  });

  it("ignores a semicolon inside a backticked identifier", () => {
    const out = sqlOf("CREATE TABLE `weird;name` (id int); SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("`weird;name`");
  });

  it("ignores semicolons inside line comments", () => {
    expect(sqlOf("-- a comment; with one\nSELECT 1;")).toHaveLength(1);
    expect(sqlOf("# another; here\nSELECT 1;")).toHaveLength(1);
  });

  it("treats -- as a comment only when whitespace follows", () => {
    // "5--3" is arithmetic. Reading it as a comment would swallow the rest of the line.
    const out = sqlOf("SELECT 5--3;\nSELECT 2;");
    expect(out).toHaveLength(2);
  });

  it("ignores semicolons inside a block comment spanning lines", () => {
    const out = sqlOf("/* one; two\n   three; four */\nSELECT 1;");
    expect(out).toHaveLength(1);
  });

  it("preserves executable /*! directives rather than dropping them", () => {
    // These are instructions in a phpMyAdmin dump, not commentary. Dropping one changes
    // what a restore does.
    const out = sqlOf("/*!40101 SET NAMES utf8 */;\nSELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("40101");
  });

  it("drops fragments that carry no executable SQL", () => {
    expect(splitStatements("-- just a comment\n")).toHaveLength(0);
    expect(splitStatements("/* only this */")).toHaveLength(0);
    expect(splitStatements("   \n\n  ")).toHaveLength(0);
  });

  it("numbers statements from one, in file order", () => {
    const out = splitStatements("SELECT 1; SELECT 2; SELECT 3;");
    expect(out.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("survives a realistic dump preamble", () => {
    const dump = [
      "-- phpMyAdmin SQL Dump",
      "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
      "CREATE TABLE `t` (`a` varchar(64) NOT NULL DEFAULT '');",
      "INSERT INTO `t` (`a`) VALUES ('x; y'), ('it''s');",
      "/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;",
    ].join("\n");
    expect(splitStatements(dump)).toHaveLength(4);
  });
});

describe("usesTransactionControl", () => {
  it("detects transaction control, which cannot survive one-request-per-statement", () => {
    expect(usesTransactionControl("START TRANSACTION; UPDATE t SET a=1; COMMIT;")).toBe(true);
    expect(usesTransactionControl("BEGIN;\nUPDATE t SET a=1;\nROLLBACK;")).toBe(true);
  });

  it("does not fire on the word appearing inside a string or an identifier", () => {
    expect(usesTransactionControl("INSERT INTO t VALUES ('COMMIT');")).toBe(false);
    expect(usesTransactionControl("SELECT `commit` FROM t;")).toBe(false);
  });

  it("leaves an ordinary migration alone", () => {
    expect(usesTransactionControl("ALTER TABLE t ADD COLUMN b int;")).toBe(false);
  });
});

describe("isReadOnly", () => {
  it("recognises the statements db_query is allowed to run", () => {
    for (const s of ["SELECT 1", "  show tables", "DESCRIBE t", "EXPLAIN SELECT 1"]) {
      expect(isReadOnly(s)).toBe(true);
    }
  });

  it("rejects anything that changes data or schema", () => {
    for (const s of ["INSERT INTO t VALUES (1)", "UPDATE t SET a=1", "DROP TABLE t", "ALTER TABLE t ADD b int"]) {
      expect(isReadOnly(s)).toBe(false);
    }
  });
});

describe("hasExecutableSql", () => {
  it("separates commentary from work", () => {
    expect(hasExecutableSql("-- nothing here")).toBe(false);
    expect(hasExecutableSql("/*!40101 SET NAMES utf8 */")).toBe(true);
    expect(hasExecutableSql("-- comment\nSELECT 1")).toBe(true);
  });
});

describe("summarise", () => {
  it("flattens whitespace and truncates long statements", () => {
    expect(summarise("SELECT\n  1,\n  2")).toBe("SELECT 1, 2");
    expect(summarise("SELECT " + "x".repeat(100), 20)).toHaveLength(20);
  });
});
