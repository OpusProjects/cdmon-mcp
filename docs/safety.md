# Safety

What this tool refuses to do, and why each refusal is there.

## Table of contents

- [The premise](#the-premise)
- [Read-only until told otherwise](#read-only-until-told-otherwise)
- [Dry run by default](#dry-run-by-default)
- [The path guard](#the-path-guard)
- [The rate limit](#the-rate-limit)
- [One statement per request](#one-statement-per-request)
- [Transaction control is refused](#transaction-control-is-refused)
- [Credentials](#credentials)
- [The audit log](#the-audit-log)
- [What is not protected](#what-is-not-protected)

---

## The premise

The caller may be a language model, and the target is a production website.

That is an unusual combination. Most tooling assumes a person typing, who will notice that a
path looks wrong before pressing return. Here the caller composes paths and SQL from context
that may be stale or misread, at a speed that outruns anyone watching. So every input is treated
as untrusted, and the defaults are the cautious ones.

---

## Read-only until told otherwise

Without `CDMON_ALLOW_WRITES`, nothing can be uploaded, deleted or changed.

Reads stay available, which makes read-only genuinely useful rather than a mode nobody runs in:
an agent can list a directory, read a config file and query the database while being unable to
alter any of it. Set the variable for the session that needs to deploy, and leave it unset the
rest of the time.

---

## Dry run by default

Every writing tool defaults to `dryRun: true`, reporting its intent instead of acting.

This costs one extra call and buys the thing that matters most: the plan is visible before it is
applied. An agent asked to "clean up the old templates" says which files it means, and a list of
eleven when you expected two is a conversation rather than a restore.

A dry run needs no permission. `CDMON_ALLOW_WRITES` is checked when an operation is about to act,
not when it is asked what it would do, so a migration can be previewed from a read-only session —
which is where you are standing when you decide whether to allow it at all.

---

## The path guard

Every file path is resolved inside `CDMON_FTP_ROOT` before it reaches the server.

Refused outright:

| Input | Why |
|---|---|
| `/etc/passwd` | Absolute paths, which ignore the root entirely |
| `../secrets.env` | Traversal above the root |
| `css/../../../etc/passwd` | Traversal that only escapes once normalised |
| `..\..\etc\passwd` | Backslash separators, which some servers accept |
| `ok.txt\0../../etc/passwd` | Null bytes, which can truncate the path server-side |
| `""` | An empty path, which would act on the root |

The check normalises before comparing, because searching for a literal `..` misses
`a/../../b`. It also refuses to *clamp*: with a root of `/`, POSIX normalisation would quietly
turn `../index.php` into `/index.php`, acting on a real file the caller never named. Refusing
is the only honest answer.

This matters more on shared hosting than it sounds. An FTP account there often has reach above
the document root — sometimes into another site on the same plan.

---

## The rate limit

FTP operations are serialised through one queue, with a pause after each.

cdmon blocks an address that connects too quickly, and getting unblocked is a support ticket
rather than a retry. An agent told to "upload the changed files" will issue twenty operations in
a row without pausing, which is precisely the pattern that triggers it. The pause applies after
failures too, since a burst of errors is the fastest way there.

`CDMON_FTP_DELAY_MS` controls it, and lowering it is a decision about your own address.

---

## One statement per request

A multi-statement file is split and sent one statement at a time.

phpMyAdmin answers a multi-statement request with a single summary, so a file that half-applied
can still look like it succeeded. One request per statement is slower and worth it: each
statement gets its own result, and a failure says exactly where it stopped.

```
statement 7 of 12 failed: Duplicate column name 'notes'. Statements 1-6 were applied.
Failing statement: ALTER TABLE users ADD COLUMN notes text
```

That message is what makes a partial apply recoverable by hand.

---

## Transaction control is refused

SQL containing `START TRANSACTION`, `BEGIN`, `COMMIT` or `ROLLBACK` is rejected before anything runs.

Each statement is its own HTTP request and therefore its own database session, so a transaction
could not span them: `BEGIN` would commit nothing and `ROLLBACK` would undo nothing. Running such
a file anyway would turn an all-or-nothing migration into a partial one while appearing to honour
it. The check reads the SQL properly, so the word appearing inside a string or a column name does
not trip it.

---

## Credentials

Credentials come from the environment and never from a tool argument.

The model driving the server sees tool names and arguments, not the environment the process was
started with. It cannot read a password, cannot pass the wrong one, and cannot repeat one into a
transcript that gets pasted into an issue later.

Two limits are worth knowing, and the first is not hypothetical.

**Plain FTP sends the password in the clear.** `CDMON_FTP_SECURE=1` asks for FTPS, but cdmon's
FTP server does not offer it — it answers the `AUTH` command with `500 AUTH not understood`, so
there is nothing to turn on. The setting exists for hosts that do support it. On cdmon, treat
the FTP password as travelling in the open, and prefer a network you trust.

**phpMyAdmin has no API**, so the database password is posted to a login form. That connection
at least is TLS, once the certificate chain is dealt with — see [phpmyadmin.md](phpmyadmin.md).

---

## The audit log

Every write appends one JSON line to `CDMON_AUDIT_LOG`.

```json
{"at":"2026-08-17T09:14:02.481Z","tool":"files_upload","detail":{"path":"/web/css/admin.css","bytes":8214},"outcome":"ok"}
```

When someone asks what happened to a site, a chat transcript is a poor answer — lossy, easily
lost, and absent entirely when the CLI ran from a script. A line per write, on disk, is what
makes "which upload replaced this file?" answerable. Reads are not logged, since they change
nothing and would bury the entries that matter.

Values under keys that look like credentials are replaced with `[redacted]`, because this file is
meant to be kept and shared. Failures to write the log are reported on stderr and otherwise
ignored: a full disk should not turn a successful deploy into a reported failure.

---

## What is not protected

Stated plainly, because a guarantee people assume is worse than one they know is absent.

- **Symlinks are not resolved.** FTP has no `realpath()`. The path guard is lexical, and a symlink
  on the server can lead somewhere it does not appear to.
- **There is no backup and no undo.** An upload replaces the destination; a delete is final. Read
  before you overwrite.
- **The audit log is not tamper-proof.** It is a normal file with normal permissions.
- **A dry run predicts, it does not reserve.** Something else can change the site between the dry
  run and the apply.
- **The write gate is per-process, not per-caller.** With `CDMON_ALLOW_WRITES` set, everything
  that can call the server can write.
