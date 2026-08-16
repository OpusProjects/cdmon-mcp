# phpMyAdmin

How the database half works, and exactly which parts of somebody else's web interface it depends on.

## Table of contents

- [Why a web session](#why-a-web-session)
- [The domain selector](#the-domain-selector)
- [The login sequence](#the-login-sequence)
- [The token rotates](#the-token-rotates)
- [Running a statement](#running-a-statement)
- [Reading the response](#reading-the-response)
- [What it depends on](#what-it-depends-on)
- [When phpMyAdmin changes](#when-phpmyadmin-changes)
- [Troubleshooting](#troubleshooting)

---

## Why a web session

cdmon exposes no database API, and shared hosting does not allow a direct MySQL connection from outside.

What a customer *does* have is phpMyAdmin in a browser. So this drives that: log in, post a
query, read the result out of the page. It works, and it is the fragile half of the project —
everything here depends on markup nobody promised to keep stable, which is why this file exists.

---

## The domain selector

cdmon runs one phpMyAdmin across every customer, and the domain is part of the session rather
than something chosen after logging in.

Set `CDMON_PMA_DOMAIN` and it travels two ways: as `d` on the query string of **every** request,
and as `pma_domain` on the login form. Both are needed — the selector scopes the session, so a
later request without it can be answered by a different server than the one the session was
established on.

| Configured | Login sends | Every URL carries |
|---|---|---|
| A domain | `pma_domain`, `route=/`, `lang=en` | `?d=<domain>` |
| No domain | `server=1` | nothing extra |

`lang=en` goes with it because the response is read by matching English strings — the `(N total`
count, the error classes. Letting the server pick a language from the request would make the
parsing quietly return nothing in another locale.

Omitting the domain against a shared install is the failure worth recognising: the login returns
the domain picker, the picker carries no token, and the client reports *no token in the
response*, which reads exactly like a wrong password.

---

## The login sequence

Two requests, because the login form carries hidden fields that must be echoed back.

| Step | Request | Purpose |
|---|---|---|
| 1 | `GET /index.php` | Fetch the login page, and the `token` and `set_session` hidden fields |
| 2 | `POST /index.php` | Send `pma_username`, `pma_password`, the domain or server fields, plus those hidden fields |

Cookies from both are kept and sent onward. A missing hidden field does not produce an error —
it produces the login page again, which then fails three requests later as something that looks
unrelated, so the fields are read where the cause is still obvious.

---

## The token rotates

phpMyAdmin issues a fresh CSRF token on every verified POST, and the next request must carry it.

This is the single easiest thing to get wrong. Reusing the token from login works for exactly
one statement, and the second is rejected with a message about the session that says nothing
about the real cause. Every response is therefore re-read for a new token — from the hidden
input, or from a script block on versions that only put it there — and the stored one is
replaced before the next statement goes out.

---

## Running a statement

One `POST /index.php?route=/import` per statement, never several at once.

```
db=your_database
table=
sql_query=SELECT id FROM users LIMIT 5
token=<current token>
session_max_rows=200
show_query=1
is_js_confirmed=0
```

`/import` is the route the SQL tab submits to, and the one that executes. `/sql` renders an
already-executed result, so posting a statement there runs nothing and answers with a page
carrying no error on it — a no-op reported as a success, which is the worst shape a bug can
take here.

The splitting happens before any of this, in `sql.ts`. It is a small state machine rather than a
`split(";")`, because a semicolon inside a string, an identifier or a comment is not a statement
boundary, and `/*!40101 ... */` is executable SQL rather than a comment — dropping one changes
what a restore does.

---

## Reading the response

The page is parsed with cheerio, not matched with regular expressions.

| Wanted | Where it comes from |
|---|---|
| Error text | `.error`, `.alert-danger`, `div.result_query .error` |
| Rows affected | `.result_query`, `.success`, `.alert-success` |
| Result rows | `table.table_results tbody tr`, cells `td[data-type]` or `td.data` |
| True row count | The "(N total" text beside the grid |

Extracting values with regular expressions over HTML is how a scraper acquires silent failures:
a cell shape nobody anticipated yields nothing, and the caller reads an empty result rather than
an error. Parsing at least fails in a way that can be seen.

Two details are easy to miss. `Javascript must be enabled` is a standing notice on the page, not
a query error, so it is ignored. And the grid is capped at `session_max_rows` while the true
total is stated beside it — without reading that, a capped result looks complete.

---

## What it depends on

The full list, so the blast radius of an upstream change is knowable rather than discovered.

| Kind | Value |
|---|---|
| Form field | `pma_username`, `pma_password`, `target`, and either `server` or `pma_domain` + `route` + `lang` |
| Hidden field | `token`, `set_session` |
| Route | `/index.php`, `/index.php?route=/import` |
| Query param | `d` (only when a domain is configured) |
| Query field | `db`, `table`, `sql_query`, `token`, `session_max_rows`, `show_query`, `is_js_confirmed` |
| Selector | `input[name="token"]`, `.error`, `.alert-danger`, `.result_query`, `.success`, `.alert-success`, `table.table_results tbody tr`, `td[data-type]`, `td.data` |

Tested against phpMyAdmin 5.x. These names have been stable for years, which is a reason for
confidence and not a guarantee.

---

## When phpMyAdmin changes

A failure here looks like a login problem, not a parsing problem, so start by naming which it is.

Run the local test server (see [development.md](development.md)) with the phpMyAdmin version you
are hosted on, and compare. If a selector in the table above no longer matches, that is the fix:
update the selector, add a test that would have caught it, and note the version in this file.

---

## Troubleshooting

The three failures worth recognising on sight.

**`no token in the response`** — the login did not complete. Check `CDMON_PMA_USER` and
`CDMON_PMA_PASS` by signing in through a browser with the same values. If those are right, the
next suspect is `CDMON_PMA_DOMAIN`: on a shared install the domain picker answers with no token
and produces this same message.

**First statement works, second fails** — the token did not rotate. That is this tool's bug, not
your configuration, and it belongs in the issue tracker.

**A result that looks empty** — check whether the query really returns nothing by running it in
the browser. If the browser shows rows and this does not, the grid selectors have moved.
