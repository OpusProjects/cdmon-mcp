# cdmon-mcp

An MCP server and CLI for deploying files and running SQL on cdmon shared hosting.

Unofficial: not affiliated with, endorsed by or supported by [cdmon](https://www.cdmon.com). Ask
cdmon about your hosting, and this repository's issues about this tool.

Small hosting plans have no SSH, no Composer, no Node and no build step: a deploy is files over FTP
and SQL through phpMyAdmin, done by hand. This exposes both as tools an AI agent can call and as
commands a CI job can run, with the host's quirks handled for you: cdmon blocks connections that
come too fast, and phpMyAdmin reports a half-applied migration as a success.

## Install

Requires Node 20 or newer, and a cdmon account with FTP and phpMyAdmin access. Nothing is installed
on the hosting.

```bash
git clone https://github.com/blaipr/cdmon-mcp.git
cd cdmon-mcp
npm install      # also builds
npm link         # optional: puts cdmon-mcp and cdmon on your PATH
```

`dist/index.js` is the MCP server and `dist/cli.js` is the `cdmon` command.

## MCP client configuration

Pass the credentials in the client's `env` block, never as tool arguments:

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
        "CDMON_PMA_DB": "your_database",
        "CDMON_PMA_DOMAIN": "your-domain.com",
        "NODE_EXTRA_CA_CERTS": "/home/you/.config/cdmon-mcp/intermediate.pem"
      }
    }
  }
}
```

The server starts read-only. Add `CDMON_ALLOW_WRITES` once you have seen it list a directory
correctly.

## Command line

The same code without a model in the loop, for scripts and CI:

```bash
cdmon files:list web/css
cdmon files:read app/Config/App.php
cdmon files:upload ./app/Config/App.php app/Config/App.php --apply
cdmon files:delete old.php --apply
cdmon files:download backup_db/latest.sql ./latest.sql
cdmon db:query "SELECT COUNT(*) FROM users"
cdmon db:dump ./backup.sql
cdmon db:execute ./sql/migration.sql --apply
```

Writes are a dry run unless you pass `--apply`, and only `--apply` needs `CDMON_ALLOW_WRITES`, so
a migration can be previewed before writing is enabled. `db:query` and `db:execute` return at most
200 rows unless you pass `--max-rows N`, and say how many they held back.

## Tools

| Tool | What it does |
|---|---|
| `files_list` | List a directory, relative to `CDMON_FTP_ROOT` |
| `files_read` | Read a text file of up to 256 KB; larger files are refused, not truncated |
| `files_upload` | Write a file from its content; a dry run unless `dryRun: false` |
| `files_delete` | Delete a file; a dry run unless `dryRun: false` |
| `db_query` | Run one read-only statement |
| `db_execute` | Run one or more statements, one request each; a dry run unless `dryRun: false` |
| `db_dump` | Export the whole database as SQL |

Only the half you configure is offered: with just the `CDMON_FTP_*` variables there are no
database tools, and the other way round. A half configured partly refuses to start. Downloading a
file to a local path is CLI-only, so the server never reads or writes your disk by path.

## Settings

All are environment variables; `.env.example` lists them.

| Variable | Default | Meaning |
|---|---|---|
| `CDMON_FTP_HOST` | | FTP hostname |
| `CDMON_FTP_USER` | | FTP username |
| `CDMON_FTP_PASS` | | FTP password |
| `CDMON_FTP_ROOT` | `/` | Directory every file operation is confined to |
| `CDMON_FTP_DELAY_MS` | `2000` | Pause after each FTP operation |
| `CDMON_FTP_TIMEOUT_MS` | `30000` | FTP timeout |
| `CDMON_FTP_SECURE` | `0` | Use FTPS (cdmon's FTP server does not offer it) |
| `CDMON_PMA_URL` | | phpMyAdmin base URL |
| `CDMON_PMA_USER` | | Database username |
| `CDMON_PMA_PASS` | | Database password |
| `CDMON_PMA_DB` | | Database name |
| `CDMON_PMA_DOMAIN` | | Hosted domain to sign into; required on cdmon |
| `CDMON_PMA_TIMEOUT_MS` | `30000` | HTTP timeout per statement |
| `CDMON_ALLOW_WRITES` | `0` | Required for uploads, deletes and data-changing SQL |
| `CDMON_AUDIT_LOG` | `./cdmon-audit.log` | Where every write is recorded, one redacted JSON line each |

Booleans accept `1`, `true`, `yes` and `on`. Set `CDMON_FTP_ROOT` narrowly: on shared hosting an
FTP account often reaches above the site's own folder.

Without `CDMON_PMA_DOMAIN`, sign-in fails with "no token in the response", which looks like a wrong
password but is not.

### cdmon's certificate chain

cdmon's phpMyAdmin sends its certificate without the intermediate, so Node fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` although browsers show the site as secure. Supply the missing
certificate rather than turning verification off (this tool has no setting for that):

```bash
# The issuer URL is in the certificate's Authority Information Access extension
openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -A1 "Authority Information Access"

curl -sS http://crt.example/TheIssuer.crt | openssl x509 -inform DER -out ~/.config/cdmon-mcp/intermediate.pem
export NODE_EXTRA_CA_CERTS=~/.config/cdmon-mcp/intermediate.pem
```

`NODE_EXTRA_CA_CERTS` must be set before Node starts: in the MCP client's `env` block, or exported
before running the CLI.

## Safety

- Read-only until `CDMON_ALLOW_WRITES` is set, and writes are still a dry run by default.
- Every path must resolve inside `CDMON_FTP_ROOT`; one that does not is refused, never clamped.
- FTP operations run one at a time, paced, because cdmon blocks bursts.
- Each SQL statement is its own request, so a partial apply is reported, never silent.
  Transaction control (`BEGIN`, `COMMIT`) is refused, since it cannot span separate requests.
- Credentials come only from the environment, never from a tool argument.

What is not protected: symlinks on the server are not resolved, there is no undo for an upload or
a delete, the audit log is an ordinary file, a dry run cannot stop the site changing before the
apply, and once writes are enabled anything that can call the server can write.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Documentation

- [Installation](docs/installation.md): requirements, client setup, the CLI and every setting
- [Tools](docs/tools.md): each tool's arguments and output
- [Safety](docs/safety.md): what is refused and why
- [phpMyAdmin](docs/phpmyadmin.md): how the web session is driven, and what markup it relies on
- [Development](docs/development.md): layout, tests and releases

## License

Apache 2.0, see [LICENSE](LICENSE).
