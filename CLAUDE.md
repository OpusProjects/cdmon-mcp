# Project Guidelines

Notes for working in this repo. Everything user-facing lives in `docs/` — this file holds only
what is easy to get wrong and expensive to discover.

## What this is

An MCP server and CLI wrapping two interfaces on cdmon shared hosting: FTP and phpMyAdmin.
That is the whole remit. It is not a cdmon API client, not a general FTP tool and not a
database GUI. Decline scope that widens it — a tool pointed at a production site earns trust
by being small enough to read in one sitting.

The caller may be a language model and the target is someone's live website. Every default is
the cautious one, and every input is untrusted.

## The three things that fail silently

Most of this codebase fails loudly: a login breaks, a transfer errors. These three do not, and
they are where the tests are concentrated.

**The path guard** (`resolveInsideRoot` in `src/ftp.ts`). A weakened check throws nothing — it
quietly permits a write or a delete outside the site. Two subtleties, both already fixed and
both easy to reintroduce:

- Normalise the *relative* path and refuse `..` **before** joining it to the root. Joining first
  looks equivalent but is not: with a root of `/`, `path.posix.normalize` clamps `/../x` back to
  `/x`, so a traversal silently becomes a valid path and acts on a file the caller never named.
- `isInside` compares with a trailing separator. Without it a root of `/site/web` also accepts
  `/site/web-backup`, which is a different directory.

**The SQL splitter** (`src/sql.ts`). A bad split does not throw; it sends malformed SQL that may
partially apply. It is a character-by-character state machine, never `split(";")`. It has to
know about single quotes (including doubled `''` and backslash escapes), double quotes,
backticks, `--` comments (only when whitespace follows — `5--3` is arithmetic), `#` comments and
`/* */` blocks. `/*!40101 ... */` is **executable SQL**, not a comment; dropping one changes what
a restore does.

**Configuration** (`src/config.ts`). A half-configured server starts fine and fails later with a
protocol error naming nothing useful. `requireAllOrNone` refuses a partly specified half. Keep
it that way, and keep empty strings treated as absent.

## Two faces, one set of rules

`src/index.ts` (MCP) and `src/cli.ts` (CLI) are separate entry points over the same core, and
that is where guarantees go to die. A safety rule each face implements for itself holds only
until somebody adds a face and forgets.

It already happened: `db_query` checked that the SQL was read-only, `db:query` did not, and
`cdmon db:query "UPDATE news SET title='x'"` rewrote 32 rows of a live production table and
reported the count as if that were a normal result. Recovering it took a backup, the activity
log and a hand-built restore.

So: **a rule that both faces need lives in the core, as the method they call.** `query()`
refuses writes; `execute()` allows them. A caller cannot forget a check that *is* the method.
Never re-implement a guard in a face, and never let one face call the permissive primitive
where the other calls the guarded one.

Related trap, same file: **never call `process.exit()` in the CLI.** Writes to a piped stdout
are asynchronous, so exiting discards whatever has not flushed — output past the 64KB pipe
buffer vanished and a half-read file looked complete. Set `process.exitCode` and let the
process end on its own.

## Invariants

Do not weaken these without saying so explicitly:

- **Two gates on every write.** `CDMON_ALLOW_WRITES` must be set *and* `dryRun` must be false.
  A new writing tool that has only one of them is a bug.
- **`db_query` / `db:query` are read-only, enforced in the core.** See above.
- **Reads are always available.** Read-only mode is useful only if it is genuinely usable.
- **One statement per phpMyAdmin request.** A multi-statement request returns a single summary,
  so a half-applied file reports success. Slower is correct here.
- **Transaction control is refused.** Each statement is its own session, so `BEGIN`/`COMMIT`
  could not span them. Refusing beats turning an all-or-nothing migration into a partial one.
- **The FTP delay applies after failures too.** A burst of errors is the fastest way to get an
  address blocked. Do not make the pause conditional on success.
- **Credentials come from the environment, never from a tool argument.** A model must not be
  able to read, pass or repeat one.
- **MCP tools never take a local filesystem path.** `files_upload` takes `content`, not a file,
  so a model's server cannot read or write local disk by path. This is why `files:download`
  (local-path-shaped by nature) is a CLI command with no MCP tool, and why `db_dump` returns
  the SQL rather than writing a file. Adding an MCP tool that takes a local path breaks this.
- **A dump that is secretly an error page is worse than no dump.** `PhpMyAdminClient.dump`
  raises when the body comes back as HTML rather than SQL. A backup is trusted precisely when
  you least want to check it, so it must never hand back a page dressed as a backup.
- **`AuditLog.record` swallows its own failures.** A full disk must not turn a successful deploy
  into a reported failure.
- **The audit log records actions that change the server or land a durable copy of its data** —
  uploads, deletes, data-changing SQL, a dump to a file, a download. Transient reads (a query,
  a file read to stdout) are not recorded; do not add them.

## Structure decisions already made

Do not "tidy" these — they were deliberate, and the reasoning is in `docs/development.md`.

- **Tools are registered inline in `src/index.ts`**, not in a `tools/` directory. The question
  that file answers is *what can this do to my site?*, and it should fit on one screen.
- **The path guard lives inside `src/ftp.ts`**, exported for testing, not in its own file. It
  serves those four operations and is read alongside them.
- **`src/sql.ts` is separate from `src/phpmyadmin.ts`.** Splitting is a pure function; running is
  a network conversation. Apart, the splitter's edge cases test in milliseconds.

## phpMyAdmin

It is a scraped web session, because cdmon exposes no database API. The traps that bite:

- **SQL executes at `route=/import`, not `route=/sql`.** `/sql` renders an already-executed
  result, so posting a statement there runs nothing and returns a page with no error on it —
  a no-op reported as success. This was a real bug, found by comparing against a working
  shell script rather than by any test.
- **A database export is two requests, not one.** The export at `route=/export` must name every
  table (`table_select[]` / `table_structure[]` / `table_data[]`), and only the export form at
  `route=/database/export` knows what they are. Fetch the form, read the table list off it,
  then post. Asking for the database without enumerating the tables yields an empty dump.
- **cdmon serves phpMyAdmin without the intermediate certificate**, so Node cannot build the
  chain and every request fails before it is sent. The fix is `NODE_EXTRA_CA_CERTS` pointing at
  the missing intermediate, never a flag that skips verification — the database password
  crosses that connection. Do not add such a flag, however often it is asked for.
- **cdmon's phpMyAdmin is shared between all its customers**, so `CDMON_PMA_DOMAIN` selects
  which database server you reach. It must go on *every* request as `d`, not only the login,
  and on the login form as `pma_domain`. Without it the login returns the domain picker, which
  carries no token, and the error reads as a wrong password.

- **An expired session is a login page with a 200.** phpMyAdmin drops an idle session after
  24 minutes and answers the next POST with the login form — no error, no grid, no count, and
  a `token` input of its own. Read as a result, that is a statement reported as applied with
  nothing affected. `runOne` checks for `pma_username` *before* reading the rotated token,
  logs in again and re-sends once; the statement never ran, so the retry cannot double-apply.
- **The CSRF token rotates on every verified POST.** Re-read it from *every* response (hidden
  input, or the script block on some versions) before the next statement. Reusing the login
  token works for exactly one statement, and the second fails with a message about the session
  that says nothing about the real cause.
- **Parse, never regex.** Extracting values from HTML with patterns is how a scraper acquires
  silent failures: an unanticipated cell shape yields nothing, and the caller reads an empty
  result rather than an error. `docs/phpmyadmin.md` lists every field and selector relied on —
  update that table when you touch one.

There is no cookie library. `undici` exports no `CookieAgent`, and a full jar buys nothing for
one origin over one short session, so `phpmyadmin.ts` keeps a small `Map` and echoes back what
the server set.

## Tests

`npm test` must always be runnable, so it is always run.

- **No network, no credentials, no containers** in `tests/`. Anything needing a real server goes
  against `tests/testserver/` (vsftpd + MariaDB + phpMyAdmin), started by hand and never by CI.
- **Fixtures use `.invalid` hostnames** so a value in a failure message is never mistaken for a
  real one. Never commit a real host, and never point a test at production.
- **Tests build their own env object**; they never read `process.env`, so a developer's own
  `CDMON_*` variables cannot change what a test asserts.
- **Sabotage-check a security test before trusting it.** Break the implementation, confirm the
  test fails, restore. A guard test that passes against a removed guard is worse than none.

## Commands

```bash
npm test           # vitest, ~45 tests, no setup
npm run typecheck
npm run build
npm run testserver:up / testserver:down
```

## CI and repo state

Two jobs: `Test` (typecheck + suite on the active Node LTS) and `Hygiene`.

The hygiene job fails on a tracked `.env`, a real-looking secret in `.env.example`, or a real
cdmon hostname anywhere outside `docs/`, `README.md` and `.github/`. It exists because that
failure is unrecoverable by revert — once credentials are pushed they are compromised and must
be rotated. Note that this file is *not* excluded from that last check, so describe the pattern
rather than writing one out.

**Branch protection on `main` is currently off**, by the owner's decision, so commits can be
amended and force-pushed directly. Prefer `--force-with-lease` over `--force`. This deviates
from the org convention (PR + required `Test` check + enforce-admins); do not silently restore
it, and do not silently rely on it either.

## Conventions

- Commit and PR titles: `<type>: short imperative summary` — `feat`, `fix`, `perf`, `refactor`,
  `docs`, `test`, `build`, `chore`. One logical change per PR, squash-merged.
- `docs/*.md`: linked table of contents, a one-line introduction before any table or code block
  in each `##` section, and a `---` rule before each `##` heading.
- `README.md` is a landing page only — no reference material. It mirrors `OpusProjects/unified-api`:
  CI badge first with the repo name in its alt text, `✨ Features`, `📚 Documentation` (table, no
  intro line), `🤝 Contributing`, `👥 Authors`, `⚖️ License`, `---` between sections, no Quick start.
- Feature bullets are `- **Name**: text` and must fit one rendered GitHub line (≤ ~100 chars).
- No orphan lines in prose: a paragraph either fits one rendered line (~116 chars) or carries
  substantial content on its last one. Check by wrapping the text, not by eye.
- `CHANGELOG.md` follows Keep a Changelog and records **user-observable changes only** — no
  entries for tests, CI, tooling or refactors.
- Code comments explain *why*, especially where the obvious implementation is wrong. The
  comments about clamping, about token rotation and about the delay-after-failure are load
  bearing; do not trim them.

## Documentation upkeep

Update the matching file as part of the change, without being asked:

| Change | File |
|---|---|
| New or changed tool, argument or output | `docs/tools.md` |
| New setting, or anything about client setup | `docs/installation.md` |
| A new refusal, gate or limit | `docs/safety.md` |
| A phpMyAdmin field, route or selector | `docs/phpmyadmin.md` |
| Layout, tests, CI or release process | `docs/development.md` |
| A user-observable change | `CHANGELOG.md` under `Unreleased` |

Add a bullet to `README.md` only when the change is user-facing enough for the top-level list.
