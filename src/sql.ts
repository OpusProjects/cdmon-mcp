/**
 * Statement-level handling of SQL text.
 *
 * phpMyAdmin answers a multi-statement request with a single summary, so sending a whole
 * file reports only its last statement. A migration could half-apply and still read as a
 * success, which is worse than failing: the operator believes the work landed. Splitting
 * here is what lets every statement carry its own result, and lets a failure name the
 * statement that caused it.
 *
 * Kept apart from the phpMyAdmin client on purpose. This is pure - text in, text out - so
 * it can be tested exhaustively in milliseconds without a network, credentials or a
 * session. It is also a property of SQL rather than of the transport, so the CLI's preview
 * and any future execution path need the same logic. And it changes almost never, while
 * the scraper changes whenever phpMyAdmin ships new markup; keeping them together would
 * mean touching stable code during unrelated edits.
 */

/** Statement text paired with its position in the original file, 1-indexed. */
export interface Statement {
  index: number;
  sql: string;
}

/**
 * Split SQL text into individual statements.
 *
 * Every character is preserved, comments included. `/*!40101 ... *​/` blocks are executable
 * directives in a phpMyAdmin dump, not commentary, and discarding them would change what a
 * restore does. The parser state exists only to decide whether a given `;` separates
 * statements or is ordinary text inside a string, an identifier or a comment.
 *
 * @param sql Raw contents of a .sql file.
 * @returns   Statements that contain something executable, in file order.
 */
export function splitStatements(sql: string): Statement[] {
  const out: string[] = [];
  let buf = "";

  let inSingle = false;
  let inDouble = false;
  let inTick = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string;
    const nx = sql[i + 1] ?? "";
    buf += c;

    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }

    if (inBlock) {
      if (c === "*" && nx === "/") {
        buf += nx;
        i++;
        inBlock = false;
      }
      continue;
    }

    if (inSingle) {
      if (c === "\\") {
        buf += nx;
        i++;
      } else if (c === "'") {
        // Doubled quote is an escaped quote, not the end of the string.
        if (nx === "'") {
          buf += nx;
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      if (c === "\\") {
        buf += nx;
        i++;
      } else if (c === '"') {
        if (nx === '"') {
          buf += nx;
          i++;
        } else {
          inDouble = false;
        }
      }
      continue;
    }

    if (inTick) {
      if (c === "`") {
        if (nx === "`") {
          buf += nx;
          i++;
        } else {
          inTick = false;
        }
      }
      continue;
    }

    // Outside every context: either open one, or treat the character as structure.
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      inTick = true;
      continue;
    }
    if (c === "#") {
      inLine = true;
      continue;
    }
    if (c === "-" && nx === "-") {
      // MySQL requires whitespace after "--", so "--x" is an operator rather than a
      // comment. Treating it as a comment would swallow the rest of the statement.
      const after = sql[i + 2] ?? "";
      if (after === "" || /\s/.test(after)) inLine = true;
      continue;
    }
    if (c === "/" && nx === "*") {
      buf += nx;
      i++;
      inBlock = true;
      continue;
    }

    if (c === ";") {
      out.push(buf.slice(0, -1));
      buf = "";
    }
  }

  // A trailing statement with no closing semicolon still counts.
  if (buf.trim() !== "") out.push(buf);

  return out
    .filter(hasExecutableSql)
    .map((sql, i) => ({ index: i + 1, sql: sql.trim() }));
}

/**
 * Does this fragment contain anything the server would act on?
 *
 * Comments are attached to the statement that follows them, so a fragment holding only
 * commentary is a no-op. Sending it alone is at best a wasted round trip and at worst an
 * error, since some phpMyAdmin versions reject an empty query.
 */
export function hasExecutableSql(fragment: string): boolean {
  const stripped = fragment
    // Executable /*! ... */ directives are kept: they are not comments.
    .replace(/\/\*(?!!)[\s\S]*?\*\//g, "")
    .replace(/--\s[^\n]*/g, "")
    .replace(/#[^\n]*/g, "");

  return stripped.trim() !== "";
}

/**
 * Does this file drive transactions itself?
 *
 * Statements are sent one request at a time, and each request is its own session. A
 * `START TRANSACTION` would therefore commit nothing and a `ROLLBACK` would have nothing
 * to undo. Refusing such a file is the honest response - running it would silently change
 * what it means, turning an all-or-nothing migration into a partial one.
 */
export function usesTransactionControl(sql: string): boolean {
  return splitStatements(sql).some(({ sql }) =>
    /^\s*(START\s+TRANSACTION|BEGIN|COMMIT|ROLLBACK|SET\s+AUTOCOMMIT)\b/i.test(sql),
  );
}

/** Is this statement read-only? Used to keep `db_query` harmless without the write flag. */
export function isReadOnly(sql: string): boolean {
  return /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(sql.trim());
}

/**
 * The first statement in `sql` that is not read-only, or null if they all are.
 *
 * Split out from the callers on purpose. A read-only guarantee that each entry point
 * implements for itself is one that holds until somebody adds an entry point and forgets -
 * which is exactly what happened: the MCP tool checked, the CLI command did not, and
 * `db:query "UPDATE ..."` ran the update against a live database and reported the rows it
 * had changed. Both faces now go through PhpMyAdminClient.query, which calls this.
 *
 * @param sql One or more statements.
 * @returns   The offending statement, carrying its 1-indexed position, or null.
 */
export function firstWritingStatement(sql: string): Statement | null {
  return splitStatements(sql).find((s) => !isReadOnly(s.sql)) ?? null;
}

/** A short single-line label for progress output and audit entries. */
export function summarise(sql: string, max = 60): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
