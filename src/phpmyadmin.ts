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
 *
 * On a phpMyAdmin shared between many customer domains - which is what cdmon runs - the
 * domain is part of the session rather than something chosen after logging in. Configure
 * CDMON_PMA_DOMAIN and it travels as `d` on every request and `pma_domain` on the login
 * form. Omitting it against such a host does not produce an error: the login returns the
 * domain picker, which carries no token, and the failure then reads as a wrong password.
 */

import * as cheerio from "cheerio";
import type { PmaConfig } from "./config.js";
import {
  firstWritingStatement,
  splitStatements,
  summarise,
  usesTransactionControl,
  type Statement,
} from "./sql.js";

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
   * Run SQL that must not change anything.
   *
   * The refusal lives here rather than in each caller. Both faces need it, and a rule that
   * every entry point re-implements is a rule that lasts until somebody adds an entry point:
   * the MCP tool checked and the CLI command did not, so `db:query "UPDATE ..."` ran the
   * update against a live database and cheerfully reported the rows it had changed. A caller
   * cannot forget a check that is the method it called.
   *
   * @param sql     One or more statements, all of which must be read-only.
   * @param maxRows Values to return per statement.
   * @returns       One result per statement, in file order.
   * @throws Error  naming the first statement that would write, before anything is sent.
   */
  async query(sql: string, maxRows = 200): Promise<StatementResult[]> {
    const writing = firstWritingStatement(sql);
    if (writing) {
      throw new Error(
        `This is a read-only query, and statement ${writing.index} is not: ` +
          `${summarise(writing.sql)}. Nothing was sent. Use db_execute (or the ` +
          "db:execute command) if you mean to change data.",
      );
    }
    return this.execute(sql, maxRows);
  }

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

  /**
   * Export the whole configured database as SQL: schema and data, every table.
   *
   * This is the backup you take before letting anything near `execute`. It changes nothing
   * on the server - phpMyAdmin builds the dump and hands it back over HTTP - so it needs no
   * write permission, the same as a read query.
   *
   * The export is a two-step conversation, not one request. phpMyAdmin's export form lists
   * the tables in hidden fields, and the export itself must name each one; asking for "the
   * database" without enumerating them yields an empty dump. So the form is fetched, the
   * table names read off it, and the export posts them back.
   *
   * @returns The dump as SQL text.
   * @throws Error if the database has no tables to export, or the server answers with a page
   *               instead of SQL (which means the session was not accepted).
   */
  async dump(): Promise<string> {
    await this.login();

    // Step one: the export form, which carries both a fresh token and the table list.
    const formHtml = await this.get(
      `/index.php?route=/database/export&db=${encodeURIComponent(this.cfg.database)}` +
        `&token=${this.token as string}`,
    );
    const $form = cheerio.load(formHtml);
    const rotated = $form('input[name="token"]').attr("value") ?? extractTokenFromScript(formHtml);
    if (rotated) this.token = rotated;

    const tables: string[] = [];
    $form('input[name="table_select[]"]').each((_, el) => {
      const value = $form(el).attr("value");
      if (value) tables.push(value);
    });

    if (tables.length === 0) {
      throw new Error(
        `No tables found to export in '${this.cfg.database}'. The database may be empty, or ` +
          "the export form did not load - check that the login and CDMON_PMA_DOMAIN are right.",
      );
    }

    // Step two: the export itself. These options are phpMyAdmin's "quick" SQL export with
    // structure and data for every table - the shape a restore expects.
    const form = new URLSearchParams({
      db: this.cfg.database,
      token: this.token as string,
      table: "",
      export_type: "database",
      export_method: "quick",
      quick_or_custom: "custom",
      what: "sql",
      structure_or_data_forced: "0",
      sql_include_comments: "something",
      sql_compatibility: "NONE",
      sql_structure_or_data: "structure_and_data",
      sql_create_table: "something",
      sql_auto_increment: "something",
      sql_create_view: "something",
      sql_procedure_function: "something",
      sql_create_trigger: "something",
      sql_backquotes: "something",
      sql_type: "INSERT",
      sql_insert_syntax: "both",
      sql_max_query_size: "50000",
      sql_utc_time: "something",
      output_format: "sendit",
      filename_template: "@DATABASE@",
      compression: "none",
    });
    for (const table of tables) {
      form.append("table_select[]", table);
      form.append("table_structure[]", table);
      form.append("table_data[]", table);
    }

    const body = await this.post("/index.php?route=/export", form);

    // A dump starts with SQL comments, never with markup. Getting a page back means the
    // export was refused - usually an expired session - and returning it as though it were a
    // backup would be the worst possible outcome for a backup.
    if (/^\s*<(?:!doctype|html)/i.test(body)) {
      throw new Error(
        "The export returned an HTML page instead of SQL, so the dump was not produced. " +
          "The session was most likely not accepted; check the credentials and CDMON_PMA_DOMAIN.",
      );
    }

    return body;
  }

  /** Log in and capture the token every later request must carry. Returns that token. */
  private async login(): Promise<string> {
    if (this.token) return this.token;

    // A session being replaced leaves cookies behind that name a session the server has
    // already forgotten. Sending them along would only have the login page come back again.
    this.cookies.clear();

    const loginPage = await this.get("/index.php");
    const $ = cheerio.load(loginPage);

    const form = loginForm(this.cfg);

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
        "phpMyAdmin login failed: no token in the response. Check CDMON_PMA_USER and " +
          "CDMON_PMA_PASS" +
          (this.cfg.domain
            ? `, and that CDMON_PMA_DOMAIN (${this.cfg.domain}) is a domain on this account.`
            : ". If this phpMyAdmin serves several domains, set CDMON_PMA_DOMAIN: without " +
              "it the login returns the domain picker, which carries no token."),
      );
    }
    this.token = token;
    return token;
  }

  /** Send one statement and turn the response page into a result. */
  private async runOne(stmt: Statement, total: number, maxRows: number): Promise<StatementResult> {
    const form = new URLSearchParams({
      db: this.cfg.database,
      // phpMyAdmin scopes the query to a table when this is set; empty means the database.
      table: "",
      sql_query: stmt.sql,
      token: this.token as string,
      session_max_rows: String(maxRows),
      show_query: "1",
      is_js_confirmed: "0",
    });

    // /import, not /sql. This is the endpoint the SQL tab submits to; /sql renders an
    // already-executed result, so posting a statement there runs nothing and returns a
    // page with no error on it - a silent no-op reported as success.
    let html = await this.post("/index.php?route=/import", form);
    let $ = cheerio.load(html);

    // An expired session answers the same way: with the login form, status 200, no error on
    // it. phpMyAdmin drops an idle session after 24 minutes by default, and an MCP server
    // lives far longer than that, so the first statement of the afternoon met this page and
    // was reported as applied with nothing affected. The page even carries a `token` input,
    // so reading the rotation below would have quietly adopted the login form's token too.
    // Nothing ran - an unauthenticated POST is turned away before it reaches MySQL - so the
    // statement is safe to send again, once, on a fresh session.
    if (isLoginPage($)) {
      this.token = null;
      form.set("token", await this.login());
      html = await this.post("/index.php?route=/import", form);
      $ = cheerio.load(html);
      if (isLoginPage($)) {
        throw new StatementError(
          stmt.index,
          total,
          stmt.sql,
          "phpMyAdmin answered with its login page again after a fresh login, so the " +
            "statement was not run. Check the credentials and CDMON_PMA_DOMAIN",
        );
      }
    }

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

    const url = buildUrl(this.cfg.url, pathname, this.cfg.domain);

    let res: Response;
    try {
      res = await fetch(url, {
        method: body ? "POST" : "GET",
        body,
        headers,
        // Redirects are followed by default, and phpMyAdmin redirects after login. The
        // cookies set on the intermediate response are applied by the runtime, but this
        // client only sees the final one, so absorbing again below is not redundant.
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      // `fetch` reports every transport failure as the same three words and hides the
      // reason on `cause`. Unwrapping it here is the difference between "fetch failed"
      // and knowing the certificate chain is incomplete.
      throw new Error(describeFetchFailure(err, this.cfg.url));
    }

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

/**
 * Is this the login form rather than a result?
 *
 * phpMyAdmin answers an unauthenticated request with the login page and a 200, so this is
 * the only way to tell an expired session from an empty result: both have no error, no grid
 * and no affected count. The username field is the one thing a result page never carries.
 */
function isLoginPage($: cheerio.CheerioAPI): boolean {
  return $('input[name="pma_username"]').length > 0;
}

/** The server's own error text, if it refused the statement. */
function readError($: cheerio.CheerioAPI): string | null {
  const candidates = [".error", ".alert-danger", "div.result_query .error"];
  for (const selector of candidates) {
    const text = $(selector).first().text().replace(/\s+/g, " ").trim();
    // "Javascript must be enabled" is a standing notice on the page, not a query error.
    if (text && !/javascript must be enabled/i.test(text)) return tidyServerError(text);
  }
  return null;
}

/**
 * Reduce a scraped error block to the part the server actually said.
 *
 * The block is laid out for a browser, so its text includes a heading, the echoed query and
 * the label of a "Copy" button. Read as a string it comes out as
 * `ErrorSQL query: Copy ALTER TABLE ... MySQL said: #1060 - Duplicate column name 'note'.` -
 * which buries the one clause that matters behind interface furniture.
 *
 * Exported for testing.
 *
 * @param text Flattened text of the error element.
 * @returns    What MySQL said, if that can be isolated; otherwise the input unchanged.
 */
export function tidyServerError(text: string): string {
  const said = /MySQL said:\s*(.+)$/is.exec(text);
  if (said?.[1]) return said[1].trim();

  // Some refusals never reach MySQL and so carry no such marker. Strip the chrome that
  // wraps them and keep the rest rather than returning nothing.
  return text
    .replace(/^Error\s*/i, "")
    .replace(/^SQL query:\s*/i, "")
    .replace(/^Copy\s*/i, "")
    .trim();
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

/**
 * Build a request URL, carrying the domain selector when there is one.
 *
 * Exported for testing. Every request needs `d`, not just the login: the selector scopes the
 * session, and a later request without it can be answered by a different server than the one
 * the session was established on.
 *
 * @param base     phpMyAdmin base URL, with no trailing slash.
 * @param pathname Path, which may already carry a query string of its own.
 * @param domain   Hosted domain to select, or null for a stock install.
 */
export function buildUrl(base: string, pathname: string, domain: string | null): string {
  if (!domain) return `${base}${pathname}`;
  const separator = pathname.includes("?") ? "&" : "?";
  return `${base}${pathname}${separator}d=${encodeURIComponent(domain)}`;
}

/**
 * The login form's fields, before the hidden ones are read off the page.
 *
 * Exported for testing, because getting this wrong raises nothing: the server answers with a
 * page either way, and the mistake surfaces later as a missing token.
 *
 * @param cfg Configuration, whose domain decides which shape the form takes.
 */
export function loginForm(cfg: PmaConfig): URLSearchParams {
  const form = new URLSearchParams({
    pma_username: cfg.user,
    pma_password: cfg.password,
    target: "index.php",
  });

  if (cfg.domain) {
    // A shared phpMyAdmin resolves the server from the domain, so `server` is not ours to
    // choose - sending 1 as well would name a server this account may not have.
    form.set("pma_domain", cfg.domain);
    form.set("route", "/");
    // Otherwise the interface language follows the browser, and the strings read back out
    // of the page - "total", the error classes - are the English ones.
    form.set("lang", "en");
  } else {
    form.set("server", "1");
  }

  return form;
}

/**
 * Turn a fetch rejection into something worth reading.
 *
 * `fetch` throws `TypeError: fetch failed` for a DNS miss, a refused connection, a timeout
 * and a bad certificate alike, putting the actual reason on `cause`. Reporting the outer
 * message alone sends the reader looking at their password when the problem is TLS.
 *
 * Exported for testing.
 *
 * @param err Whatever fetch rejected with.
 * @param url The configured base URL, for a message that names the host.
 */
export function describeFetchFailure(err: unknown, url: string): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  const detail = cause?.message ?? (err instanceof Error ? err.message : String(err));

  // An incomplete chain is the one worth naming outright: the certificate is valid and the
  // root is trusted, but the server omitted the intermediate that joins them, so nothing
  // about the site looks wrong from a browser.
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
    return (
      `Could not verify the TLS certificate of ${url}: ${code}. The server is most likely ` +
      "sending its leaf certificate without the intermediate that links it to a trusted " +
      "root. Fetch the issuer named in the certificate's Authority Information Access " +
      "extension and point NODE_EXTRA_CA_CERTS at it before starting. Do that rather than " +
      "disabling verification: the chain still gets checked, and the database password " +
      "goes over this connection. See docs/phpmyadmin.md."
    );
  }

  if (code === "CERT_HAS_EXPIRED") {
    return `The TLS certificate of ${url} has expired. This is the host's to fix, not yours.`;
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Could not resolve ${url}. Check CDMON_PMA_URL and this machine's DNS.`;
  }

  if (code === "ECONNREFUSED") {
    return `Connection refused by ${url}. Check CDMON_PMA_URL, including its port and scheme.`;
  }

  if (err instanceof Error && err.name === "TimeoutError") {
    return `${url} did not answer in time. Raise CDMON_PMA_TIMEOUT_MS if the host is simply slow.`;
  }

  return `Request to ${url} failed: ${code ? `${code}: ` : ""}${detail}`;
}

/** Some versions only surface the rotated token inside a script block. */
function extractTokenFromScript(html: string): string | null {
  const match = /token["']?\s*[:=]\s*["']([a-f0-9]+)["']/i.exec(html);
  return match?.[1] ?? null;
}
