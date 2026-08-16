# cdmon-mcp

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.6-3178c6.svg)](https://www.typescriptlang.org)
[![CI](https://github.com/OpusProjects/cdmon-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OpusProjects/cdmon-mcp/actions/workflows/ci.yml)

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by cdmon.
> It is an independent tool that drives the FTP and phpMyAdmin interfaces a cdmon customer
> already has. "cdmon" is used here only to say which hosting it works with. Ask cdmon for
> support with your hosting; ask [this issue tracker](https://github.com/OpusProjects/cdmon-mcp/issues)
> about this tool.

An MCP server and CLI for deploying files and running SQL on cdmon shared hosting, written in TypeScript.

Small shared hosting plans have no SSH, no Composer, no Node and no build step — a deploy is
files over FTP and SQL through phpMyAdmin, both done by hand. This exposes those two things as
tools an AI agent can use, and as commands a CI job can run, without either one having to
rediscover that the host blocks an address which connects too quickly.

## ✨ Features

- **Files over FTP** — list, read, upload and delete, confined to a configured root
- **SQL through phpMyAdmin** — one statement per request, so a partial apply is never silent
- **Read-only until told otherwise** — writes need `CDMON_ALLOW_WRITES`, and default to a dry run
- **Path traversal refused** — every path is resolved inside the root before it reaches the server
- **Rate limited by default** — operations are serialised and paced, because cdmon blocks bursts
- **Transaction control refused** — SQL that spans statements it cannot span is rejected, not half-run
- **Audited** — every write appends a redacted JSON line you can keep, grep and share
- **Same core in CI** — a `cdmon` CLI over the identical code, for jobs with no model in them
- **Credentials never in tool arguments** — they come from the environment, so a model cannot read them

## 📚 Documentation

Each area has its own file under [`docs/`](docs).

| Document | What it covers |
|---|---|
| [Installation](docs/installation.md) | Requirements, MCP client configuration, CLI use, every setting |
| [Tools](docs/tools.md) | The tools an agent can call, their arguments and their output |
| [Safety](docs/safety.md) | What is refused and why: writes, paths, transactions, the audit log |
| [phpMyAdmin](docs/phpmyadmin.md) | How the web session is driven, and which markup it depends on |
| [Development](docs/development.md) | Layout, tests, the local test server, release process |

## 🤝 Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the ground rules. Security reports go through
[SECURITY.md](SECURITY.md) rather than the public tracker.

## 👥 Authors

- Blai Peidro ([github.com/blaipr](https://github.com/blaipr))

## ⚖️ License

Apache-2.0 — see [LICENSE](LICENSE).
