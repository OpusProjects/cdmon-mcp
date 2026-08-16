# Security policy

This tool holds credentials to a live website and a live database, so a vulnerability in it
is a vulnerability in whatever it is pointed at. Reports are taken seriously.

## Table of contents

- [Supported versions](#supported-versions)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [What to expect](#what-to-expect)
- [What counts as a vulnerability here](#what-counts-as-a-vulnerability-here)
- [Known limitations](#known-limitations)
- [Keeping your own deployment safe](#keeping-your-own-deployment-safe)

---

## Supported versions

Fixes go onto the latest release; older ones are not patched.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything earlier | No |

---

## Reporting a vulnerability

Report privately, not in the public issue tracker.

Use [GitHub's private vulnerability reporting](https://github.com/OpusProjects/cdmon-mcp/security/advisories/new)
on this repository. Please include what an attacker gains, the steps to reproduce it, and the
version you tested — a proof of concept is welcome but never required.

Never include real credentials, hostnames or database contents in a report. A path and a
description are enough.

---

## What to expect

A first reply within a week, and an honest answer about severity.

Confirmed issues are fixed and released, and the report is credited in the advisory unless
you would rather it were not. If a report turns out not to be a vulnerability, you will be
told why rather than left waiting.

---

## What counts as a vulnerability here

Anything that lets a caller reach past the boundaries this tool claims to enforce.

| Class | Example |
|---|---|
| Path escape | A path that writes or deletes outside `CDMON_FTP_ROOT` |
| Write gate bypass | A change applied with `CDMON_ALLOW_WRITES` unset, or with `dryRun` true |
| Credential exposure | A password reaching a tool result, an error message or the audit log |
| Silent partial apply | SQL reported as successful when only some statements landed |
| Injection | Caller input reaching SQL or an FTP command in a way that changes its meaning |

---

## Known limitations

These are design constraints, documented rather than fixed, and are not vulnerabilities.

- **Symlinks are not resolved.** FTP is remote, so there is no `realpath()`. The path guard is
  lexical, and a symlink placed on the server can still lead somewhere unintended.
- **FTP without FTPS sends the password in the clear.** `CDMON_FTP_SECURE=1` if your plan
  accepts it. The default is off because not every plan does.
- **phpMyAdmin is a web session, not an API.** Credentials are posted to a login form, and
  results are parsed out of HTML. See [docs/phpmyadmin.md](docs/phpmyadmin.md).
- **The audit log is not tamper-proof.** It is an append-only file with normal permissions,
  useful for reconstructing what happened, not for proving it to someone hostile.

---

## Keeping your own deployment safe

Most of the risk is in configuration rather than code.

- Leave `CDMON_ALLOW_WRITES` unset until a session actually needs to write, and unset it after.
- Set `CDMON_FTP_ROOT` to the narrowest directory that works — often the document root, not `/`.
- Keep `.env` out of version control. It is gitignored here, and CI fails if one is ever committed.
- Use a database user with only the privileges the work needs.
- Read the audit log after an agent-driven session. That is what it is for.
