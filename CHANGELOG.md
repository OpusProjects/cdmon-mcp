# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-17

### Added

- MCP server exposing `files_list`, `files_read`, `files_upload` and `files_delete` over FTP.
- MCP server exposing `db_query` for read-only SQL and `db_execute` for changes, through phpMyAdmin.
- `cdmon` CLI over the same core, for CI jobs and scripts, where `--apply` opts into writing.
- Write gate: uploads, deletes and data-changing SQL require `CDMON_ALLOW_WRITES`.
- Dry run by default on every write, so an agent reports its intent before acting on it.
- Path guard confining every FTP operation inside `CDMON_FTP_ROOT`.
- Serialised, rate-limited FTP operations, paced by `CDMON_FTP_DELAY_MS`.
- One SQL statement per phpMyAdmin request, each reported separately, naming the failing one.
- Refusal of SQL that drives its own transactions, which cannot span statements sent separately.
- Append-only audit log of every write, with credential-shaped values redacted.

[Unreleased]: https://github.com/OpusProjects/cdmon-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OpusProjects/cdmon-mcp/releases/tag/v0.1.0
