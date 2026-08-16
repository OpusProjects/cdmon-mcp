# Development

Repository layout, how the tests are organised, and how to release.

## Table of contents

- [Layout](#layout)
- [Why the modules split where they do](#why-the-modules-split-where-they-do)
- [Running the tests](#running-the-tests)
- [The local test server](#the-local-test-server)
- [Continuous integration](#continuous-integration)
- [Releasing](#releasing)

---

## Layout

Source under `src/`, tests under `tests/`, documentation under `docs/`.

```
src/
  index.ts        MCP entry point: transport, tool registration, the write gate
  cli.ts          command line face, over the same core
  config.ts       environment parsing and validation
  ftp.ts          FTP client, rate limit and path guard
  sql.ts          statement splitting and classification
  phpmyadmin.ts   the web session that runs SQL
  audit.ts        append-only record of every write
tests/
  ftp.test.ts     the path guard, tested directly
  sql.test.ts     the splitter, tested hardest
  config.test.ts  what the loader accepts and refuses
  fixtures.ts     shared sample data, no network, no credentials
  testserver/     docker compose stack, started by hand
docs/
```

Tools are registered inline in `index.ts` rather than in a directory of their own. The whole
surface an agent can reach fits on one screen, and the question that file answers — *what can
this thing do to my site?* — should not need three files opened to establish.

---

## Why the modules split where they do

Each file is one thing that can be reasoned about, and in two cases one thing that can be tested
without a server.

`sql.ts` is separate from `phpmyadmin.ts` because splitting SQL is a pure function over a string
and running it is a network conversation. Fused, the splitter could only be tested through an
HTTP session; apart, its two dozen edge cases run in milliseconds — and those cases are where the
real danger is, since a bad split does not throw, it sends malformed SQL.

The path guard is the opposite call: it lives *inside* `ftp.ts`, exported, rather than in a file
of its own. It exists only to serve those four operations, it is read alongside them, and the
comment explaining why it refuses to clamp belongs next to the code that would otherwise have
clamped. It is still a pure function, so `tests/ftp.test.ts` exercises it with no connection.

---

## Running the tests

The suite needs no credentials, no network and no container.

```bash
npm test           # once
npm run test:watch
npm run typecheck
npm run build
```

Anything that cannot be asserted without a real server belongs against the test server below,
never in the fast suite. The rule is that `npm test` is always runnable, so it is always run.

---

## The local test server

A stand-in for cdmon hosting — vsftpd, MariaDB and phpMyAdmin — started deliberately, never by CI.

```bash
npm run testserver:up
npm run testserver:down
```

It is for the questions unit tests cannot answer: whether a login actually succeeds, whether the
token really rotates between statements, whether a directory listing parses. The credentials are
fixed, everything binds to `127.0.0.1`, and nothing is hardened.

`CDMON_FTP_DELAY_MS=0` is safe against this stack and only against this stack. The pause exists
because cdmon blocks an address that connects too quickly, and a container does not.

---

## Continuous integration

Two jobs run on every push and pull request.

| Job | What it checks |
|---|---|
| `test` | `npm ci`, typecheck, and the full suite on Node 22 |
| `hygiene` | No tracked `.env`, no real secret in `.env.example`, no real hostname outside docs |

`test` is the required check for merging. The hygiene job exists because the failure it catches
is unrecoverable by revert: once credentials are pushed, they are compromised and have to be
rotated, so it is worth catching before the push rather than after.

---

## Releasing

Versions are SemVer with a `v` prefix, and the release title equals the tag name.

1. Update `CHANGELOG.md`, moving entries out of `Unreleased` under the new version.
2. Bump `version` in `package.json`.
3. Merge to `main` and wait for CI.
4. Tag `vX.Y.Z` and create the release with that exact title.

The changelog records user-observable changes only. Tests, CI and refactors are not entries —
someone reading it wants to know what changed about the tool, not about its repository.
