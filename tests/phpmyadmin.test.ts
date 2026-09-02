/**
 * The two pieces of the phpMyAdmin session that can be checked without a server.
 *
 * Both matter more than they look. Getting either wrong raises no error: the server answers
 * with a page regardless, and the mistake surfaces one request later as a missing token,
 * which reads exactly like a wrong password.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUrl,
  describeFetchFailure,
  loginForm,
  PhpMyAdminClient,
  tidyServerError,
} from "../src/phpmyadmin.js";
import { firstWritingStatement } from "../src/sql.js";
import type { PmaConfig } from "../src/config.js";

const BASE = "https://pma.example.invalid";

function cfg(domain: string | null): PmaConfig {
  return {
    url: BASE,
    user: "example-user",
    password: "example-password",
    database: "example_db",
    domain,
    timeoutMs: 30000,
  };
}

describe("buildUrl", () => {
  it("leaves the URL alone when there is no domain to select", () => {
    expect(buildUrl(BASE, "/index.php", null)).toBe(`${BASE}/index.php`);
    expect(buildUrl(BASE, "/index.php?route=/import", null)).toBe(`${BASE}/index.php?route=/import`);
  });

  it("appends the selector with ? when the path has no query", () => {
    expect(buildUrl(BASE, "/index.php", "site.example")).toBe(`${BASE}/index.php?d=site.example`);
  });

  it("appends the selector with & when the path already has a query", () => {
    // Using ? twice produces a URL where the server sees no route at all.
    expect(buildUrl(BASE, "/index.php?route=/import", "site.example")).toBe(
      `${BASE}/index.php?route=/import&d=site.example`,
    );
  });

  it("encodes a domain that needs it", () => {
    expect(buildUrl(BASE, "/index.php", "a b&c.example")).toBe(
      `${BASE}/index.php?d=a%20b%26c.example`,
    );
  });
});

describe("loginForm", () => {
  it("sends server=1 on a stock install, and no domain fields", () => {
    const form = loginForm(cfg(null));
    expect(form.get("server")).toBe("1");
    expect(form.get("pma_domain")).toBeNull();
    expect(form.get("lang")).toBeNull();
  });

  it("sends the domain instead of a server number when one is configured", () => {
    // A shared phpMyAdmin resolves the server from the domain. Naming server 1 as well
    // would point at a server this account may not have.
    const form = loginForm(cfg("site.example"));
    expect(form.get("pma_domain")).toBe("site.example");
    expect(form.get("route")).toBe("/");
    expect(form.get("server")).toBeNull();
  });

  it("pins the interface language when a domain is used", () => {
    // The response is read by matching English strings and classes, so letting the server
    // pick the language from the request would make the parsing fail in another locale.
    expect(loginForm(cfg("site.example")).get("lang")).toBe("en");
  });

  it("always carries the credentials", () => {
    for (const domain of [null, "site.example"]) {
      const form = loginForm(cfg(domain));
      expect(form.get("pma_username")).toBe("example-user");
      expect(form.get("pma_password")).toBe("example-password");
    }
  });
});

describe("query refuses to write", () => {
  /**
   * The regression that cost a production table.
   *
   * `db:query "UPDATE news SET title='x'"` ran the update against a live database and
   * reported "32 row(s) affected". The MCP tool had the read-only check; the CLI command
   * called execute() directly and had none. Putting the refusal inside query() is what makes
   * the two faces agree, and these assert it from the outside.
   */
  const client = () => new PhpMyAdminClient(cfg("site.example"));

  it("refuses a statement that changes data", async () => {
    await expect(client().query("UPDATE news SET title='x'")).rejects.toThrow(/read-only/i);
    await expect(client().query("DELETE FROM news")).rejects.toThrow(/read-only/i);
    await expect(client().query("DROP TABLE news")).rejects.toThrow(/read-only/i);
  });

  it("refuses before anything is sent, and says so", async () => {
    // The host is unroutable, so a request would fail with a transport error instead. Only
    // a refusal that happens first can produce this message.
    await expect(client().query("UPDATE news SET title='x'")).rejects.toThrow(/Nothing was sent/);
  });

  it("names the offending statement by position, not just that one exists", async () => {
    const sql = "SELECT 1; SELECT 2; UPDATE news SET title='x';";
    await expect(client().query(sql)).rejects.toThrow(/statement 3/);
  });

  it("catches a write hidden after read-only statements", async () => {
    // Checking only the first statement would let this through.
    await expect(client().query("SELECT 1; DELETE FROM news;")).rejects.toThrow(/read-only/i);
  });

  it("points at the command that is allowed to write", async () => {
    await expect(client().query("UPDATE news SET title='x'")).rejects.toThrow(/db_execute/);
  });
});

describe("firstWritingStatement", () => {
  it("returns null when everything is read-only", () => {
    expect(firstWritingStatement("SELECT 1; SHOW TABLES;")).toBeNull();
  });

  it("returns the first writer with its position", () => {
    const found = firstWritingStatement("SELECT 1; UPDATE t SET a=1; DELETE FROM t;");
    expect(found?.index).toBe(2);
    expect(found?.sql).toContain("UPDATE");
  });
});

describe("tidyServerError", () => {
  it("keeps only what MySQL said", () => {
    // The real shape, scraped from a live phpMyAdmin: a heading, the echoed query, and the
    // label of a Copy button, all ahead of the one clause that explains the failure.
    const scraped =
      "ErrorSQL query: Copy ALTER TABLE `cdmon_probe` ADD COLUMN `note` text; " +
      "MySQL said: #1060 - Duplicate column name 'note'.";
    expect(tidyServerError(scraped)).toBe("#1060 - Duplicate column name 'note'.");
  });

  it("copes with the marker spanning lines", () => {
    expect(tidyServerError("Error\nSQL query:\nSELECT 1\nMySQL said:\n#1064 - syntax")).toBe(
      "#1064 - syntax",
    );
  });

  it("strips the chrome when there is no marker at all", () => {
    // Not every refusal reaches MySQL, and returning nothing would be worse than untidy.
    expect(tidyServerError("ErrorSQL query: Copy DROP DATABASE x")).toBe("DROP DATABASE x");
  });

  it("leaves an already-clean message alone", () => {
    expect(tidyServerError("Access denied for user")).toBe("Access denied for user");
  });
});

describe("describeFetchFailure", () => {
  /** fetch's own shape: a flat TypeError with the real reason hidden on `cause`. */
  const failure = (code: string, message = "") =>
    Object.assign(new TypeError("fetch failed"), { cause: { code, message } });

  it("names an incomplete certificate chain and what to do about it", () => {
    // The failure this exists for. Nothing about such a site looks wrong in a browser,
    // so without naming it the reader goes hunting through their credentials.
    const text = describeFetchFailure(failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), BASE);
    expect(text).toContain("intermediate");
    expect(text).toContain("NODE_EXTRA_CA_CERTS");
    expect(text).toContain(BASE);
  });

  it("steers away from disabling verification rather than towards it", () => {
    // The easy answer is to stop checking certificates, and the database password goes
    // over this connection. The message must not read as an invitation.
    const text = describeFetchFailure(failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), BASE);
    expect(text).toMatch(/rather than disabling verification/i);
  });

  it("distinguishes the other transport failures", () => {
    expect(describeFetchFailure(failure("ENOTFOUND"), BASE)).toMatch(/resolve/i);
    expect(describeFetchFailure(failure("ECONNREFUSED"), BASE)).toMatch(/refused/i);
    expect(describeFetchFailure(failure("CERT_HAS_EXPIRED"), BASE)).toMatch(/expired/i);
  });

  it("reports a timeout as a timeout, not as a failure of the request", () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(describeFetchFailure(timeout, BASE)).toMatch(/CDMON_PMA_TIMEOUT_MS/);
  });

  it("still says something useful for a cause it does not recognise", () => {
    // Never fall back to bare "fetch failed" — that is the message this replaces.
    const text = describeFetchFailure(failure("ESOMETHINGNEW", "socket hang up"), BASE);
    expect(text).toContain("ESOMETHINGNEW");
    expect(text).toContain("socket hang up");
    expect(text).not.toBe("fetch failed");
  });

  it("copes with a rejection that carries no cause at all", () => {
    expect(describeFetchFailure(new Error("something broke"), BASE)).toContain("something broke");
    expect(describeFetchFailure("not even an error", BASE)).toContain("not even an error");
  });
});

describe("an expired session", () => {
  /**
   * phpMyAdmin drops an idle session after 24 minutes by default, and answers the next request
   * with its login form - status 200, no error on it, no grid, no affected count. Read as a
   * result, that is a statement reported as applied with nothing affected. The MCP server
   * lives far longer than a session does, so this is the ordinary case, not a corner.
   */
  const LOGIN_PAGE =
    '<html><body><form><input name="pma_username"><input name="pma_password">' +
    '<input name="token" value="login-token"><input name="set_session" value="s1">' +
    "</form></body></html>";
  const home = (token: string) =>
    `<html><body><input type="hidden" name="token" value="${token}"></body></html>`;
  const RESULT_PAGE =
    '<html><body><input type="hidden" name="token" value="after"><div class="success">' +
    "1 row affected.</div></body></html>";

  /** A scripted server: answers the given pages in order and keeps what it was sent. */
  function serve(pages: string[]) {
    const sent: { url: string; body: string | null }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: init?.body ? String(init.body) : null });
      const page = pages.shift();
      if (page === undefined) throw new Error("test server: no page scripted for this request");
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return sent;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in again and re-sends the statement, once", async () => {
    const sent = serve([
      LOGIN_PAGE, // GET  /index.php          - first login
      home("t1"), // POST /index.php          - logged in
      LOGIN_PAGE, // POST /import             - session gone, login form comes back
      LOGIN_PAGE, // GET  /index.php          - second login
      home("t2"), // POST /index.php          - logged in again
      RESULT_PAGE, // POST /import            - the statement, really run this time
    ]);

    const [result] = await new PhpMyAdminClient(cfg(null)).execute("UPDATE t SET a = 1");

    expect(result?.affectedRows).toBe(1);
    const imports = sent.filter((r) => r.url.includes("route=/import"));
    expect(imports).toHaveLength(2);
    // The retry carries the new session's token, not the one the login page happened to show.
    expect(new URLSearchParams(imports[1]?.body ?? "").get("token")).toBe("t2");
  });

  it("refuses to report the statement as applied when the login page comes back twice", async () => {
    serve([LOGIN_PAGE, home("t1"), LOGIN_PAGE, LOGIN_PAGE, home("t2"), LOGIN_PAGE]);

    const run = new PhpMyAdminClient(cfg(null)).execute("UPDATE t SET a = 1");
    await expect(run).rejects.toThrow(/login page again/);
    await expect(run).rejects.toThrow(/was not run/);
  });

  it("does not adopt the login form's token as the rotated one", async () => {
    // The login page carries a `token` input of its own. Reading rotation off it would make
    // the retry, and every statement after, carry a token the session never issued.
    const sent = serve([LOGIN_PAGE, home("t1"), LOGIN_PAGE, LOGIN_PAGE, home("t2"), RESULT_PAGE]);
    await new PhpMyAdminClient(cfg(null)).execute("UPDATE t SET a = 1");
    for (const r of sent.filter((r) => r.url.includes("route=/import"))) {
      expect(new URLSearchParams(r.body ?? "").get("token")).not.toBe("login-token");
    }
  });

  it("leaves a statement that got a real answer alone", async () => {
    const sent = serve([LOGIN_PAGE, home("t1"), RESULT_PAGE]);
    const [result] = await new PhpMyAdminClient(cfg(null)).execute("UPDATE t SET a = 1");
    expect(result?.affectedRows).toBe(1);
    expect(sent).toHaveLength(3);
  });
});
