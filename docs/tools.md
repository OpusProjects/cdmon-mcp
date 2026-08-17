# Tools

The complete surface an agent can reach, with the arguments each tool takes and the output it returns.

## Table of contents

- [Which tools appear](#which-tools-appear)
- [files_list](#files_list)
- [files_read](#files_read)
- [files_upload](#files_upload)
- [files_delete](#files_delete)
- [db_query](#db_query)
- [db_execute](#db_execute)
- [CLI equivalents](#cli-equivalents)

---

## Which tools appear

Only the tools whose half is configured are registered, so the surface matches what you set up.

| Configured | Tools offered |
|---|---|
| `CDMON_FTP_*` | `files_list`, `files_read`, `files_upload`, `files_delete` |
| `CDMON_PMA_*` | `db_query`, `db_execute` |

Writing tools are still registered when `CDMON_ALLOW_WRITES` is unset — they exist and refuse,
with a message saying which variable would enable them. Reads are always available.

---

## files_list

Lists a directory on the site, relative to the configured root.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `.` | Directory, relative to `CDMON_FTP_ROOT` |

Output is one line per entry, with a leading `d` for directories:

```
d         0  css
-      4096  index.php
-       812  robots.txt
```

---

## files_read

Reads a small text file: a config file, a template, a log.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | File, relative to the root |

Files over 256 KB are refused rather than truncated. Half a file returned as though it were
whole is worse than an error, because the caller cannot tell the difference — and an agent
that reads half a config file will confidently edit the wrong thing.

---

## files_upload

Uploads text content, creating parent directories as needed.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | Destination, relative to the root |
| `content` | string | — | File contents |
| `dryRun` | boolean | `true` | Report what would happen without doing it |

Requires `CDMON_ALLOW_WRITES`. Note the default: an agent that calls this without thinking gets
`[dry run] would upload 812 bytes to web/css/admin.css` and has to ask again to mean it.

The upload replaces the destination outright. There is no server-side backup and no undo, so on
a live site read the file first if you intend to keep any of it.

---

## files_delete

Deletes one file from the site.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | File to delete, relative to the root |
| `dryRun` | boolean | `true` | Report what would happen without doing it |

Requires `CDMON_ALLOW_WRITES`. Directories are not deleted — only files — so a mistaken path
cannot take a tree with it.

---

## db_query

Runs a read-only query and returns the rows.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `sql` | string | — | A single read-only statement |
| `maxRows` | number | `200` | Values returned before the rest are reported as held back |

`SELECT`, `SHOW`, `DESCRIBE` and `EXPLAIN` are accepted; anything else is refused by name:

```
db_query is read-only; statement 1 is not: UPDATE users SET active = 0. Use db_execute.
```

When more rows exist than were returned, the output says so and gives the true total. A capped
result that looked complete would be read as "there are only 200 users", which is a wrong answer
rather than a partial one.

---

## db_execute

Runs SQL that changes data or schema, one statement per request.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `sql` | string | — | One or more statements |
| `dryRun` | boolean | `true` | List the statements without running them |
| `maxRows` | number | `200` | Values returned per statement |

Requires `CDMON_ALLOW_WRITES`. A dry run lists what would run, numbered, which is the last
chance to notice that a file holds eleven statements rather than the one you meant:

```
[dry run] 3 statement(s) would run:
  [1] ALTER TABLE users ADD COLUMN notes text
  [2] UPDATE users SET notes = '' WHERE notes IS NULL
  [3] INSERT INTO configuration (config_key, config_value) VALUES ('notes_enabled', '1')
```

Each statement is reported separately when it runs, and a failure names which one failed and
how many had already been applied. SQL that drives its own transactions is refused outright —
see [safety.md](safety.md) for why.

---

## CLI equivalents

Every tool has a command, over the same code, for jobs with no model in them.

| Tool | Command |
|---|---|
| `files_list` | `cdmon files:list [path]` |
| `files_read` | `cdmon files:read <path>` |
| `files_upload` | `cdmon files:upload <local> <remote> [--apply]` |
| `files_delete` | `cdmon files:delete <remote> [--apply]` |
| `db_query` | `cdmon db:query <sql> [--max-rows N]` |
| `db_execute` | `cdmon db:execute <file.sql> [--apply] [--max-rows N]` |

The `dryRun` argument becomes `--apply`, inverted: both faces default to not writing, and both
require the caller to say so a second time. `maxRows` becomes `--max-rows`, with the same
default of 200.

A dry run needs no permission on either face. `CDMON_ALLOW_WRITES` is checked when an operation
is about to act for real, not when it is asked what it would do — otherwise a migration could
not be previewed from the read-only session where you are deciding whether to allow it.
