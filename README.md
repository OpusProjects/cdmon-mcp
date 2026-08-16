# cdmon MCP

[![cdmon-mcp CI](https://github.com/OpusProjects/cdmon-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/OpusProjects/cdmon-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-7.0-3178c6.svg?logo=typescript)](https://www.typescriptlang.org/)

> **⚠️ Unofficial**
>
> Not affiliated with, endorsed by or supported by [cdmon](https://www.cdmon.com).<br>
> Ask cdmon about your hosting; ask [this tracker](https://github.com/OpusProjects/cdmon-mcp/issues) about this tool.

MCP server and CLI for deploying files and running SQL on cdmon shared hosting, written in TypeScript.

Small hosting plans have no SSH, no Composer, no Node and no build step. A
deploy there is files over FTP and SQL through phpMyAdmin, both done by hand,
one file at a time.

cdmon MCP exposes those two interfaces as tools an AI agent can call and as
commands a CI job can run. Neither has to rediscover that the host blocks an
address which connects too quickly, or that phpMyAdmin reports a half-applied
migration as a success — both are built into the tools themselves rather than
written in a runbook.

---

## ✨ Features

- **Files over FTP**: list, read, upload and delete, confined to a configured root
- **SQL through phpMyAdmin**: one statement per request, so a partial apply is never silent
- **Read-only by default**: writes need `CDMON_ALLOW_WRITES`, and then still default to a dry run
- **Path traversal refused**: every path resolves inside the root, and is never quietly clamped
- **Rate limited**: operations are serialised and paced, because cdmon blocks bursts
- **Transactions refused**: SQL that cannot span separate requests is rejected, not half-run
- **Audited**: every write appends a redacted JSON line you can keep, grep and share
- **Same core in CI**: a `cdmon` CLI over identical code, for jobs with no model in them
- **Credentials out of reach**: they come from the environment, never from a tool argument
- **No dependencies on the host**: nothing is installed on the hosting, which is the point

---

## 📚 Documentation

| Document | What it covers |
|---|---|
| [Development](docs/development.md) | Layout, why the modules split where they do, tests, releases |
| [Installation](docs/installation.md) | Requirements, MCP client configuration, CLI use, every setting |
| [phpMyAdmin](docs/phpmyadmin.md) | How the web session is driven, and which markup it depends on |
| [Safety](docs/safety.md) | What is refused and why: writes, paths, transactions, the audit log |
| [Tools](docs/tools.md) | The tools an agent can call, their arguments and their output |

---

## 🤝 Contributing

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) covers the PR workflow, commit style, tests and scope.

Security issues: see [SECURITY.md](SECURITY.md) for private reporting.

---

## 👥 Authors

- [Blai Peidro](https://github.com/blaipr)

---

## ⚖️ License

[Apache 2.0](LICENSE)
