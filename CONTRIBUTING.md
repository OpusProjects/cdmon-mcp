# Contributing

Thanks for considering a contribution. This is a small project with a narrow purpose, and
the sections below cover how to get a change in.

## Table of contents

- [Before you start](#before-you-start)
- [Getting set up](#getting-set-up)
- [Workflow](#workflow)
- [Commit and pull request titles](#commit-and-pull-request-titles)
- [Tests](#tests)
- [Documentation](#documentation)
- [Scope](#scope)

---

## Before you start

Open an issue first for anything larger than a fix, so the design can be agreed before the work.

Small corrections — a typo, a broken link, a wrong default in the docs — need no issue. Go
straight to a pull request.

---

## Getting set up

Node 20 or newer, and nothing else.

```bash
git clone https://github.com/OpusProjects/cdmon-mcp.git
cd cdmon-mcp
npm install
npm test
```

The tests need no credentials, no network and no container. If any of them asks for one,
that is a bug in the test.

---

## Workflow

One logical change per pull request, squash-merged into `main`.

| Step | What to do |
|---|---|
| Branch | `<type>/<short-name>`, e.g. `fix/token-rotation` |
| Commit | One per logical change, titled as described below |
| Open | Fill in the pull request template |
| Merge | Only once CI is green; the branch is deleted on merge |

---

## Commit and pull request titles

Titles use a type prefix followed by a short imperative summary.

```
fix: refuse a traversal when the root is /
```

The accepted types are `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build` and `chore`.

---

## Tests

Every change to behaviour needs a test that fails without it.

The three things most worth testing here are the SQL splitter, the path guard and the
configuration loader, because all three fail *quietly* when they are wrong — a bad split sends
malformed SQL, a weak guard permits a write outside the site, and a half-configured server
starts happily and breaks on first use. Assertions about them belong in the fast suite that
always runs, never behind a container someone might skip.

```bash
npm test          # once
npm run test:watch
npm run typecheck
```

---

## Documentation

Documentation lives in `docs/`, one file per area, and the README is a landing page only —
no reference material in it.

A change that adds a tool, a setting or a refusal is not finished until the matching file
under `docs/` says so. Each of those files opens with a linked table of contents, gives every
`##` section a one-line introduction before any table or code block, and puts a `---` rule
before each heading.

---

## Scope

This wraps two interfaces: FTP and phpMyAdmin. That is the whole remit.

It is deliberately not a cdmon API client, not a general-purpose FTP tool and not a database
GUI. Proposals that widen it that far are likely to be declined, however good they are — a
tool an agent points at a production site earns trust by being small enough to read.
