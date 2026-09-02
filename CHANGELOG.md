# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The `cdmon` and `cdmon-mcp` commands did nothing, and exited 0, when run through the links
  `npm link` or `npm install -g` create. The main-module check now resolves symlinks first.
- `db_query` and `db:query` refused only by leading keyword, so `EXPLAIN ANALYZE UPDATE ...`
  changed rows and `SELECT ... INTO OUTFILE` wrote a file from a read-only query. Both are now
  refused, like any other write.

## [0.2.0] - 2026-08-18

### Added

- `db_dump` (`cdmon db:dump [file]`) — export the whole database as SQL, schema and data. Read-only,
  so it needs no write permission; the backup to take before a migration.
- `cdmon files:download <remote> <local>` — stream a remote file to disk, byte for byte, any size.
  For backups and binaries, which `files:read` cannot handle. Command line only.

## [0.1.0] - 2026-08-17

### Added

- MCP server exposing `files_list`, `files_read`, `files_upload` and `files_delete` over FTP.
- MCP server exposing `db_query` for read-only SQL and `db_execute` for changes, through phpMyAdmin.
- `cdmon` CLI over the same core, for CI jobs and scripts, where `--apply` opts into writing.
- `--max-rows` on the CLI, matching the `maxRows` tool argument, defaulting to 200.
- Write gate: uploads, deletes and data-changing SQL require `CDMON_ALLOW_WRITES`.
- Dry run by default on every write, so an agent reports its intent before acting on it.
- Path guard confining every FTP operation inside `CDMON_FTP_ROOT`.
- Serialised, rate-limited FTP operations, paced by `CDMON_FTP_DELAY_MS`.
- One SQL statement per phpMyAdmin request, each reported separately, naming the failing one.
- `CDMON_PMA_DOMAIN`, for a phpMyAdmin shared between many customer domains, as cdmon runs it.
- Refusal of SQL that drives its own transactions, which cannot span statements sent separately.
- Append-only audit log of every write, with credential-shaped values redacted.

[Unreleased]: https://github.com/OpusProjects/cdmon-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/OpusProjects/cdmon-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/OpusProjects/cdmon-mcp/releases/tag/v0.1.0
