/**
 * Runs SQL through a phpMyAdmin web session.
 *
 * cdmon exposes no database API, so this drives the interface a person would use: log in,
 * post a query, read the result out of the page. That makes this the fragile half of the
 * project - it depends on markup nobody promised to keep stable - and the reason
 * docs/phpmyadmin.md records exactly which fields and selectors it relies on.
 *
 * Two decisions are worth stating up front.
 *
 * The response is parsed, not pattern-matched. Extracting values with regular expressions
 * over HTML is how a scraper acquires silent failures: a cell type nobody anticipated
 * returns nothing at all, and the caller reads that as an empty result rather than an
 * error.
 *
 * Statements are sent one per request. phpMyAdmin answers a multi-statement request with a
 * single summary, so a file could half-apply and still report success. One request per
 * statement is slower and worth it: every statement gets its own result, and a failure
 * names the statement that caused it and how many had already landed.
 */

import * as cheerio from "cheerio";
import type { PmaConfig } from "./config.js";
import { splitStatements, summarise, usesTransactionControl, type Statement } from "./sql.js";

/** The outcome of one statement. */
export interface StatementResult {
  index: number;
  sql: string;
  affectedRows: number | null;
  rows: string[][];
  totalRows: number | null;
  truncated: boolean;
}

/** Raised when the server rejects a statement, carrying enough context to resume by hand. */
export class StatementError extends Error {
  constructor(
    readonly index: number,
    readonly total: number,
    readonly sql: string,
    readonly serverMessage: string,
  ) {
    super(
      `statement ${index} of ${total} failed: ${serverMessage}. ` +
        `Statements 1-${index - 1} were applied. Failing statement: ${summarise(sql)}`,
    );
    this.name = "StatementError";
  }
}

export class PhpMyAdminClient {
  private token: string | null = null;

  /**
   * Session cookies, kept by name.
   *
   * A general cookie jar would bring domain matching, expiry and path rules along with it,
   * none of which apply: every request in this client goes to one origin, within one short
   * session, and the only cookies that matter are the ones phpMyAdmin just set. Echoing
   * back what the server sent is the whole requirement.
   */
  private readonly cookies = new Map<string, string>();

  constructor(private readonly cfg: PmaConfig) {}

  /**
   * Execute SQL, one statement per request.
   *
   * @param sql       Raw SQL, possibly containing many statements.
   * @param maxRows   Values to return per statement before reporting the rest as held back.
   * @returns         One result per executed statement, in file order.
   * @throws Error          if the file drives its own transactions.
   * @throws StatementError on the first statement the server rejects.
   */
  async execute(sql: string, maxRows = 200): Promise<StatementResult[]> {
    // Each statement is its own request and therefore its own session, so a transaction
    // could not span them: BEGIN would commit nothing, ROLLBACK would undo nothing.
    // Refusing beats silently turning an all-or-nothing migration into a partial one.
    if (usesTransactionControl(sql)) {
      throw new Error(
        "This SQL drives its own transactions (START TRANSACTION / COMMIT / ROLLBACK). " +
          "Statements are sent one per request, so each runs in its own session and the " +
          "transaction would not span them. Apply it by hand, or restructure it.",
      );
    }

    const statements = splitStatements(sql);
    if (statements.length === 0) return [];

    await this.login();

    const results: StatementResult[] = [];
    for (const stmt of statements) {
      results.push(await this.runOne(stmt, statements.length, maxRows));
    }
    return results;
  }

  /** Log in and capture the token every later request must carry. */
  private async login(): Promise<void> {
    if (this.token) return;

    const loginPage = await this.get("/index.php");
    const $ = cheerio.load(loginPage);

    const form = new URLSearchParams({
      pma_username: this.cfg.user,
      pma_password: this.cfg.password,
      server: "1",
      target: "index.php",
    });

    // Both hidden fields are required. Their names have been stable for years, but a
    // missing one produces a login page rather than an error, so it is checked here where
    // the cause is obvious rather than three requests later where it is not.
    for (const field of ["token", "set_session"]) {
      const value = $(`input[name="${field}"]`).attr("value");
      if (value) form.set(field, value);
    }

    const afterLogin = await this.post("/index.php", form);
    const $after = cheerio.load(afterLogin);
    const token = $after('input[name="token"]').attr("value") ?? extractTokenFromScript(afterLogin);

    if (!token) {
      throw new Error(
        "phpMyAdmin login failed: no token in the response. Check CDMON_PMA_USER and CDMON_PMA_PASS.",
      );
    }
    this.token = token;
  }

  /** Send one statement and turn the response page into a result. */
  private async runOne(stmt: Statement, total: number, maxRows: number): Promise<StatementResult> {
    const form = new URLSearchParams({
      db: this.cfg.database,
      sql_query: stmt.sql,
      token: this.token as string,
      session_max_rows: String(maxRows),
    });

    const html = await this.post("/index.php?route=/sql", form);
    const $ = cheerio.load(html);

    // The token rotates on every verified POST. Missing this means the next statement is
    // rejected for a reason that looks nothing like the real one.
    const rotated = $('input[name="token"]').attr("value") ?? extractTokenFromScript(html);
    if (rotated) this.token = rotated;

    const error = readError($);
    if (error) throw new StatementError(stmt.index, total, stmt.sql, error);

    const rows = readGrid($);
    const totalRows = readReportedTotal($);

    return {
      index: stmt.index,
      sql: stmt.sql,
      affectedRows: readAffected($),
      rows,
      totalRows,
      truncated: totalRows !== null && totalRows > rows.length,
    };
  }

  private get(pathname: string): Promise<string> {
    return this.request(pathname);
  }

  private post(pathname: string, body: URLSearchParams): Promise<string> {
    return this.request(pathname, body);
  }

  /** One request, carrying the session forward and absorbing whatever the server sets. */
  private async request(pathname: string, body?: URLSearchParams): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";

    const res = await fetch(`${this.cfg.url}${pathname}`, {
      method: body ? "POST" : "GET",
      body,
      headers,
      // Redirects are followed by default, and phpMyAdmin redirects after login. The
      // cookies set on the intermediate response are applied by the runtime, but this
      // client only sees the final one, so absorbing again below is not redundant.
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    this.absorbCookies(res);
    return res.text();
  }

  /** Record every cookie the response set, replacing any earlier value of the same name. */
  private absorbCookies(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An expiring cookie is sent with an empty value; keeping it would send a session
      // identifier the server has already discarded.
      if (value === "" || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

/** The server's own error text, if it refused the statement. */
function readError($: cheerio.CheerioAPI): string | null {
  const candidates = [".error", ".alert-danger", "div.result_query .error"];
  for (const selector of candidates) {
    const text = $(selector).first().text().replace(/\s+/g, " ").trim();
    // "Javascript must be enabled" is a standing notice on the page, not a query error.
    if (text && !/javascript must be enabled/i.test(text)) return text;
  }
  return null;
}

/** Rows affected by an INSERT, UPDATE, DELETE or DDL statement. */
function readAffected($: cheerio.CheerioAPI): number | null {
  const text = $(".result_query, .success, .alert-success").first().text();
  const match = /(\d+)\s+row/i.exec(text);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

/** Result grid, as rows of cell text. */
function readGrid($: cheerio.CheerioAPI): string[][] {
  const rows: string[][] = [];
  $("table.table_results tbody tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .find("td[data-type], td.data")
      .each((_, td) => {
        cells.push($(td).text().trim());
      });
    if (cells.length > 0) rows.push(cells);
  });
  return rows;
}

/**
 * The true row count, which the grid does not show.
 *
 * phpMyAdmin caps the grid at session_max_rows and states the real total beside it -
 * "Showing rows 0 - 24 (28 total". Without reading that, a capped result looks complete.
 */
function readReportedTotal($: cheerio.CheerioAPI): number | null {
  const text = $("body").text();
  const match = /\((\d+)\s+total/i.exec(text);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

/** Some versions only surface the rotated token inside a script block. */
function extractTokenFromScript(html: string): string | null {
  const match = /token["']?\s*[:=]\s*["']([a-f0-9]+)["']/i.exec(html);
  return match?.[1] ?? null;
}
