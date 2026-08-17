/**
 * The path guard, tested directly.
 *
 * It lives in ftp.ts alongside the client, but it is a pure function and these cases need
 * no connection, so they run in milliseconds and always. That matters: this is the check
 * whose failure permits a write or a delete outside the site, and security tests should
 * never be the slow ones people skip.
 */

import { describe, expect, it } from "vitest";
import { describeFtpFailure, isInside, PathError, resolveInsideRoot } from "../src/ftp.js";

const ROOT = "/site/web";

describe("resolveInsideRoot", () => {
  it("resolves an ordinary relative path", () => {
    expect(resolveInsideRoot(ROOT, "css/admin.css")).toBe("/site/web/css/admin.css");
    expect(resolveInsideRoot(ROOT, "./index.php")).toBe("/site/web/index.php");
  });

  it("allows the root itself", () => {
    expect(resolveInsideRoot(ROOT, ".")).toBe(ROOT);
  });

  it("refuses an absolute path", () => {
    expect(() => resolveInsideRoot(ROOT, "/etc/passwd")).toThrow(PathError);
  });

  it("refuses a plain traversal", () => {
    expect(() => resolveInsideRoot(ROOT, "../secrets.env")).toThrow(PathError);
    expect(() => resolveInsideRoot(ROOT, "../../etc/passwd")).toThrow(PathError);
  });

  it("refuses a traversal that only escapes after normalising", () => {
    // No leading "..", so a substring check for ".." would pass this through.
    expect(() => resolveInsideRoot(ROOT, "css/../../../etc/passwd")).toThrow(PathError);
    expect(() => resolveInsideRoot(ROOT, "a/b/../../../..")).toThrow(PathError);
  });

  it("refuses backslash separators used to dodge the check", () => {
    expect(() => resolveInsideRoot(ROOT, "..\\..\\etc\\passwd")).toThrow(PathError);
  });

  it("refuses a null byte, which can truncate the path server-side", () => {
    expect(() => resolveInsideRoot(ROOT, "ok.txt\0../../etc/passwd")).toThrow(PathError);
  });

  it("refuses an empty or blank path", () => {
    expect(() => resolveInsideRoot(ROOT, "")).toThrow(PathError);
    expect(() => resolveInsideRoot(ROOT, "   ")).toThrow(PathError);
  });

  it("allows a traversal that stays inside", () => {
    // Going up and back down is legitimate as long as it lands within the root.
    expect(resolveInsideRoot(ROOT, "css/../js/app.js")).toBe("/site/web/js/app.js");
  });

  it("works when the root is /", () => {
    expect(resolveInsideRoot("/", "index.php")).toBe("/index.php");
    expect(() => resolveInsideRoot("/", "../index.php")).toThrow(PathError);
  });

  it("tolerates a trailing slash on the root", () => {
    expect(resolveInsideRoot("/site/web/", "a.txt")).toBe("/site/web/a.txt");
  });
});

describe("describeFtpFailure", () => {
  const PATH = "/site/web/missing.txt";

  it("translates a dropped data connection into the likely cause", () => {
    // What a missing file actually produces on this host. "read ECONNRESET (data socket)"
    // is a message about sockets for a problem about a filename.
    const text = describeFtpFailure(new Error("read ECONNRESET (data socket)"), PATH);
    expect(text).toContain(PATH);
    expect(text).toMatch(/does not exist/i);
  });

  it("translates 550, from the message or the code", () => {
    expect(describeFtpFailure(new Error("550 Failed to open file."), PATH)).toMatch(/no such file/i);
    expect(describeFtpFailure(Object.assign(new Error("nope"), { code: 550 }), PATH)).toMatch(
      /no such file/i,
    );
  });

  it("points a login refusal at the credentials", () => {
    expect(describeFtpFailure(new Error("530 Login incorrect."), PATH)).toMatch(/CDMON_FTP_PASS/);
  });

  it("explains that a rejected AUTH means no FTPS, rather than a fault to chase", () => {
    // What cdmon's server actually answers. Read literally it looks like a broken command.
    const text = describeFtpFailure(new Error("500 AUTH not understood"), PATH);
    expect(text).toMatch(/does not support FTPS/i);
    expect(text).toMatch(/CDMON_FTP_SECURE/);
  });

  it("mentions the ban risk on a timeout, since that is the usual cause here", () => {
    const text = describeFtpFailure(new Error("Timeout (control socket)"), PATH);
    expect(text).toMatch(/blocked for connecting too often/i);
  });

  it("distinguishes host problems from path problems", () => {
    expect(describeFtpFailure(new Error("getaddrinfo ENOTFOUND h"), PATH)).toMatch(/CDMON_FTP_HOST/);
    expect(describeFtpFailure(new Error("connect ECONNREFUSED"), PATH)).toMatch(/refused/i);
  });

  it("keeps the original message when it recognises nothing", () => {
    const text = describeFtpFailure(new Error("something unusual"), PATH);
    expect(text).toContain("something unusual");
    expect(text).toContain(PATH);
  });
});

describe("isInside", () => {
  it("does not accept a directory that merely shares a prefix", () => {
    // Without a trailing separator in the comparison, "/site/web-backup" would pass as
    // being inside "/site/web". It is a different directory entirely.
    expect(isInside("/site/web", "/site/web-backup/x")).toBe(false);
    expect(isInside("/site/web", "/site/website")).toBe(false);
  });

  it("accepts the root and anything beneath it", () => {
    expect(isInside("/site/web", "/site/web")).toBe(true);
    expect(isInside("/site/web", "/site/web/css/a.css")).toBe(true);
  });
});
