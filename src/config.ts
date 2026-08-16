/**
 * Configuration, read from the environment and validated once at startup.
 *
 * Credentials arrive here and nowhere else. They are never tool arguments, so a model
 * driving this server cannot see them, cannot pass the wrong ones, and cannot repeat them
 * into a transcript. An MCP client supplies them through its own `env` block; the CLI reads
 * the same variables from the shell or a .env file.
 *
 * Half-configured is treated as unconfigured. A server that starts with an FTP host but no
 * password will fail on first use with a confusing protocol error, which is a worse
 * outcome than refusing to start with a message naming the variable that is missing.
 */

import { z } from "zod";

/** Everything the FTP client needs. */
export interface FtpConfig {
  host: string;
  user: string;
  password: string;
  root: string;
  delayMs: number;
  timeoutMs: number;
  secure: boolean;
}

/** Everything the phpMyAdmin client needs. */
export interface PmaConfig {
  url: string;
  user: string;
  password: string;
  database: string;
  timeoutMs: number;
}

export interface Config {
  ftp: FtpConfig | null;
  pma: PmaConfig | null;
  allowWrites: boolean;
  auditLog: string;
}

const schema = z.object({
  CDMON_FTP_HOST: z.string().min(1).optional(),
  CDMON_FTP_USER: z.string().min(1).optional(),
  CDMON_FTP_PASS: z.string().min(1).optional(),
  CDMON_FTP_ROOT: z.string().default("/"),
  CDMON_FTP_DELAY_MS: z.coerce.number().int().min(0).default(2000),
  CDMON_FTP_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  CDMON_FTP_SECURE: z.string().optional(),

  CDMON_PMA_URL: z.string().url().optional(),
  CDMON_PMA_USER: z.string().min(1).optional(),
  CDMON_PMA_PASS: z.string().min(1).optional(),
  CDMON_PMA_DB: z.string().min(1).optional(),
  CDMON_PMA_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  CDMON_ALLOW_WRITES: z.string().optional(),
  CDMON_AUDIT_LOG: z.string().default("./cdmon-audit.log"),
});

/**
 * Build the configuration from a set of environment variables.
 *
 * @param env Usually process.env; taken as a parameter so tests need not mutate it.
 * @returns   A validated configuration, with each half present only if fully specified.
 * @throws    Error naming the missing variables when a half is partly configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = parsed.data;

  const ftp = requireAllOrNone("FTP", {
    CDMON_FTP_HOST: e.CDMON_FTP_HOST,
    CDMON_FTP_USER: e.CDMON_FTP_USER,
    CDMON_FTP_PASS: e.CDMON_FTP_PASS,
  })
    ? {
        host: e.CDMON_FTP_HOST as string,
        user: e.CDMON_FTP_USER as string,
        password: e.CDMON_FTP_PASS as string,
        root: e.CDMON_FTP_ROOT,
        delayMs: e.CDMON_FTP_DELAY_MS,
        timeoutMs: e.CDMON_FTP_TIMEOUT_MS,
        secure: isTruthy(e.CDMON_FTP_SECURE),
      }
    : null;

  const pma = requireAllOrNone("phpMyAdmin", {
    CDMON_PMA_URL: e.CDMON_PMA_URL,
    CDMON_PMA_USER: e.CDMON_PMA_USER,
    CDMON_PMA_PASS: e.CDMON_PMA_PASS,
    CDMON_PMA_DB: e.CDMON_PMA_DB,
  })
    ? {
        url: (e.CDMON_PMA_URL as string).replace(/\/$/, ""),
        user: e.CDMON_PMA_USER as string,
        password: e.CDMON_PMA_PASS as string,
        database: e.CDMON_PMA_DB as string,
        timeoutMs: e.CDMON_PMA_TIMEOUT_MS,
      }
    : null;

  if (!ftp && !pma) {
    throw new Error(
      "Nothing is configured. Set the CDMON_FTP_* variables, the CDMON_PMA_* variables, or both. " +
        "See .env.example.",
    );
  }

  return {
    ftp,
    pma,
    allowWrites: isTruthy(e.CDMON_ALLOW_WRITES),
    auditLog: e.CDMON_AUDIT_LOG,
  };
}

/**
 * All of a group's variables, or none of them.
 *
 * @returns true when the group is fully configured, false when it is entirely absent.
 * @throws  Error naming the missing variables when the group is partly configured.
 */
function requireAllOrNone(label: string, group: Record<string, string | undefined>): boolean {
  const missing = Object.entries(group)
    .filter(([, v]) => v === undefined || v === "")
    .map(([k]) => k);

  if (missing.length === 0) return true;
  if (missing.length === Object.keys(group).length) return false;

  throw new Error(
    `${label} is partly configured. Missing: ${missing.join(", ")}. ` +
      "Set all of them, or none, so the server does not start in a state that fails on first use.",
  );
}

/** Accept the spellings people actually write in a .env file. */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
