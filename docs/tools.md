# Tools

The complete surface an agent can reach, with the arguments each tool takes and the output it returns.

## Table of contents

- [Which tools appear](#which-tools-appear)
- [files_list](#files_list)
- [files_read](#files_read)
- [files_download](#files_download)
- [files_upload](#files_upload)
- [files_delete](#files_delete)
- [db_query](#db_query)
- [db_execute](#db_execute)
- [db_dump](#db_dump)
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

For anything larger, or anything not text, use `files:download` instead.

---

## files_download

Streams a remote file to a local path, byte for byte. **Command line only** — see below.

| Argument | Meaning |
|---|---|
| `<remote>` | File on the site, relative to the root |
| `<local>` | Local destination; its parent directory must already exist |

This is the counterpart to `files_read`, for the cases `read` deliberately will not handle: a
file of any size, and a file that is not text. `read` decodes as UTF-8 and caps at 256 KB, so a
JPEG read that way comes back inflated and corrupt; `download` writes the raw bytes to disk, so
a backup or an image arrives intact. A failed transfer removes the partial file rather than
leaving a truncated one that looks whole.

It is read-only on the server and needs no `CDMON_ALLOW_WRITES` — it writes to your disk, not to
the site. It is recorded in the audit log all the same, because it lands a durable copy of the
site's data.

It has no MCP tool on purpose. The MCP tools never take a local filesystem path — `files_upload`
takes `content`, not a local file — so the server a model drives cannot read or write the local
disk by path. A download is inherently local-path-shaped, so it lives on the CLI, where scripts
and CI jobs are the ones fetching backups.

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

## db_dump

Exports the whole database as SQL — schema and data, every table.

This tool takes no arguments and returns the dump. It is read-only: phpMyAdmin builds the SQL
and hands it back, changing nothing, so it needs no `CDMON_ALLOW_WRITES` — the same standing as
`db_query`.

It is the backup to take before letting anything near `db_execute`. On the CLI, `db:dump` writes
to a file when given one and to standard output otherwise:

```bash
cdmon db:dump backup.sql          # 126053 bytes written to backup.sql
cdmon db:dump > backup.sql        # same, via a redirect
```

The export is a two-request conversation rather than one call — phpMyAdmin lists the tables on
its export form, and the export must name each of them — but that is internal; see
[phpmyadmin.md](phpmyadmin.md). A response that comes back as an HTML page rather than SQL is
treated as a failed export and raised, never returned as though it were a backup.

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
| `db_dump` | `cdmon db:dump [file.sql]` |
| _(none)_ | `cdmon files:download <remote> <local>` |

`files:download` is the one command with no MCP tool behind it, because it writes to a local
path and the MCP tools deliberately never do. See [files_download](#files_download).

The `dryRun` argument becomes `--apply`, inverted: both faces default to not writing, and both
require the caller to say so a second time. `maxRows` becomes `--max-rows`, with the same
default of 200.

A dry run needs no permission on either face. `CDMON_ALLOW_WRITES` is checked when an operation
is about to act for real, not when it is asked what it would do — otherwise a migration could
not be previewed from the read-only session where you are deciding whether to allow it.
