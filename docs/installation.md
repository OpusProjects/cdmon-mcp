# Installation

How to install the server, point an MCP client at it, and configure the two halves it can drive.

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [MCP client configuration](#mcp-client-configuration)
- [Command line use](#command-line-use)
- [Settings](#settings)
- [Configuring only one half](#configuring-only-one-half)
- [Finding your cdmon details](#finding-your-cdmon-details)
- [Checking it works](#checking-it-works)

---

## Requirements

Node 20 or newer on the machine running the server, and a cdmon account with FTP and phpMyAdmin access.

Nothing is needed on the hosting itself. That is the point: the server talks to interfaces
that already exist, so the host needs no SSH, no Composer, no Node and no build step.

---

## Install

Install from the repository, since this is not published to npm.

```bash
git clone https://github.com/OpusProjects/cdmon-mcp.git
cd cdmon-mcp
npm install       # also builds, via the prepare script
```

That leaves two executables under `dist/`: `dist/index.js` is the MCP server, and
`dist/cli.js` is the `cdmon` command.

---

## MCP client configuration

Register the server with your MCP client, passing credentials through its `env` block.

```json
{
  "mcpServers": {
    "cdmon": {
      "command": "node",
      "args": ["/absolute/path/to/cdmon-mcp/dist/index.js"],
      "env": {
        "CDMON_FTP_HOST": "ftp.example.com",
        "CDMON_FTP_USER": "your-ftp-user",
        "CDMON_FTP_PASS": "your-ftp-password",
        "CDMON_FTP_ROOT": "/web",
        "CDMON_PMA_URL": "https://phpmyadmin.example.com",
        "CDMON_PMA_USER": "your-database-user",
        "CDMON_PMA_PASS": "your-database-password",
        "CDMON_PMA_DB": "your_database"
      }
    }
  }
}
```

Credentials belong in that block and never in a tool argument. The model driving the server
sees the tools and their arguments, not the environment it was started with, so it cannot read
a password, pass the wrong one, or repeat one into a transcript.

Note what is missing above: `CDMON_ALLOW_WRITES`. Without it the server starts read-only, which
is the right way to meet a new setup. Add it once you have watched it list a directory correctly.

---

## Command line use

The same code is reachable without a model in the loop, for CI jobs and scripts.

```bash
export $(grep -v '^#' .env | xargs)     # or set the variables however you prefer

cdmon files:list web/css
cdmon files:upload ./app/Config/App.php app/Config/App.php --apply
cdmon db:query "SELECT COUNT(*) FROM users"
cdmon db:execute ./sql/migration.sql --apply
```

Writes are a dry run unless `--apply` is given, so a mistyped command reports what it would
have done instead of doing it. Only `--apply` needs `CDMON_ALLOW_WRITES`; a dry run does not,
so a migration can be previewed before writing is enabled.

`db:query` and `db:execute` also take `--max-rows N`, defaulting to 200. A capped result says
how many rows it held back rather than looking complete.

---

## Settings

Every setting is an environment variable, and [`.env.example`](../.env.example) lists them all.

| Variable | Default | Meaning |
|---|---|---|
| `CDMON_FTP_HOST` | — | FTP hostname |
| `CDMON_FTP_USER` | — | FTP username |
| `CDMON_FTP_PASS` | — | FTP password |
| `CDMON_FTP_ROOT` | `/` | Directory every file operation is confined to |
| `CDMON_FTP_DELAY_MS` | `2000` | Pause after each FTP operation, successful or not |
| `CDMON_FTP_TIMEOUT_MS` | `30000` | FTP timeout |
| `CDMON_FTP_SECURE` | `0` | Use FTPS — not offered by cdmon's FTP server, see [safety](safety.md) |
| `CDMON_PMA_URL` | — | phpMyAdmin base URL |
| `CDMON_PMA_USER` | — | Database username |
| `CDMON_PMA_PASS` | — | Database password |
| `CDMON_PMA_DB` | — | Database name |
| `CDMON_PMA_DOMAIN` | — | Hosted domain to sign into, on a phpMyAdmin shared between many |
| `CDMON_PMA_TIMEOUT_MS` | `30000` | HTTP timeout per statement |
| `CDMON_ALLOW_WRITES` | `0` | Required for uploads, deletes and data-changing SQL |
| `CDMON_AUDIT_LOG` | `./cdmon-audit.log` | Where the record of every write is appended |

Booleans accept `1`, `true`, `yes` and `on`; anything else is false.

`CDMON_FTP_ROOT` is worth setting narrowly. It is the boundary the path guard enforces, and on
shared hosting an FTP account often has reach above the document root — sometimes into another
site entirely.

On cdmon you will also need `NODE_EXTRA_CA_CERTS`, because their phpMyAdmin sends an incomplete
certificate chain that Node refuses. It is a standard Node variable rather than one of this
project's, and [phpmyadmin.md](phpmyadmin.md#the-incomplete-certificate-chain) explains how to
produce the file it points at.

`CDMON_PMA_DOMAIN` is required on cdmon and absent on a stock install. cdmon runs one
phpMyAdmin for every customer and resolves which database server you reach from that value.
Leaving it out does not produce a useful error: the login returns the domain picker, the picker
carries no token, and the failure surfaces as *no token in the response* — which reads like a
wrong password and sends you checking the wrong thing.

---

## Configuring only one half

FTP and phpMyAdmin are independent, and either can be configured alone.

Set only the `CDMON_FTP_*` variables and the database tools are not registered at all; set only
the `CDMON_PMA_*` ones and the file tools disappear instead. An agent cannot call a tool that
was never offered, which is a stronger guarantee than one that exists and refuses.

A *partly* configured half is a different matter and refuses to start:

```
FTP is partly configured. Missing: CDMON_FTP_PASS. Set all of them, or none, so the
server does not start in a state that fails on first use.
```

That is deliberate. A server that starts with a host but no password would fail on the first
upload with a protocol error naming nothing useful.

---

## Finding your cdmon details

All four values come from the cdmon control panel, under the hosting entry for your domain.

FTP credentials are in the FTP accounts section — host, username, and a password you set there.
The phpMyAdmin URL and the database name and user are in the databases section. If you already
deploy this site by hand, these are the same details you type into an FTP client and the
phpMyAdmin login page.

---

## Checking it works

Start with a read, before enabling anything else.

```bash
cdmon files:list .
cdmon db:query "SHOW TABLES"
```

Both work with `CDMON_ALLOW_WRITES` unset. If the listing shows your site and the query shows
your tables, the configuration is right, and you can decide whether this session should be
allowed to write — see [safety.md](safety.md).
