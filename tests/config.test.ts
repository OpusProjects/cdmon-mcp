/**
 * Configuration is validated once at startup, and what it refuses matters as much as what
 * it accepts: a half-configured server starts fine and fails later with a protocol error
 * that names nothing useful.
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { env, FTP_ENV, PMA_ENV } from "./fixtures.js";

describe("loadConfig", () => {
  it("builds both halves when both are fully specified", () => {
    const config = loadConfig(env(FTP_ENV, PMA_ENV));
    expect(config.ftp?.host).toBe("ftp.example.invalid");
    expect(config.pma?.database).toBe("example_db");
  });

  it("allows one half alone", () => {
    expect(loadConfig(env(FTP_ENV)).pma).toBeNull();
    expect(loadConfig(env(PMA_ENV)).ftp).toBeNull();
  });

  it("refuses a partly configured half, naming what is missing", () => {
    const { CDMON_FTP_PASS: _omitted, ...partial } = FTP_ENV;
    expect(() => loadConfig(env(partial as Record<string, string>))).toThrow(/CDMON_FTP_PASS/);
  });

  it("refuses an empty string as though the variable were absent", () => {
    // `export CDMON_PMA_PASS=` is a common way to end up here, and it is not a password.
    expect(() => loadConfig(env(PMA_ENV, { CDMON_PMA_PASS: "" }))).toThrow(/CDMON_PMA_PASS/);
  });

  it("refuses an empty environment rather than starting with no capability", () => {
    expect(() => loadConfig(env())).toThrow(/Nothing is configured/);
  });

  it("starts read-only unless writes are opted into", () => {
    expect(loadConfig(env(FTP_ENV)).allowWrites).toBe(false);
    for (const value of ["1", "true", "yes", "on", "TRUE", " Yes "]) {
      expect(loadConfig(env(FTP_ENV, { CDMON_ALLOW_WRITES: value })).allowWrites).toBe(true);
    }
    for (const value of ["0", "false", "no", "", "maybe"]) {
      expect(loadConfig(env(FTP_ENV, { CDMON_ALLOW_WRITES: value })).allowWrites).toBe(false);
    }
  });

  it("keeps the rate limit on by default", () => {
    // Removing the pause is what gets an address blocked, so it has to be deliberate.
    expect(loadConfig(env(FTP_ENV)).ftp?.delayMs).toBe(2000);
    expect(loadConfig(env(FTP_ENV, { CDMON_FTP_DELAY_MS: "0" })).ftp?.delayMs).toBe(0);
  });

  it("defaults the root to / and keeps an explicit one", () => {
    expect(loadConfig(env(FTP_ENV)).ftp?.root).toBe("/");
    expect(loadConfig(env(FTP_ENV, { CDMON_FTP_ROOT: "/site/web" })).ftp?.root).toBe("/site/web");
  });

  it("trims a trailing slash from the phpMyAdmin URL", () => {
    // Otherwise every request path becomes a double slash, which some setups redirect and
    // others reject.
    const config = loadConfig(env(PMA_ENV, { CDMON_PMA_URL: "https://pma.example.invalid/" }));
    expect(config.pma?.url).toBe("https://pma.example.invalid");
  });

  it("rejects a phpMyAdmin URL that is not a URL", () => {
    expect(() => loadConfig(env(PMA_ENV, { CDMON_PMA_URL: "pma.example.invalid" }))).toThrow(
      /Invalid configuration/,
    );
  });

  it("rejects a timeout too small to be meant", () => {
    expect(() => loadConfig(env(FTP_ENV, { CDMON_FTP_TIMEOUT_MS: "10" }))).toThrow(
      /Invalid configuration/,
    );
  });
});
