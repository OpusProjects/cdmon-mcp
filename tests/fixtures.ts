/**
 * Shared fixtures.
 *
 * Nothing here touches the network or the filesystem. The credentials are obvious fakes so
 * that a value appearing in a failure message is never mistaken for a real one.
 */

/** A complete FTP half, ready to be spread into an env object. */
export const FTP_ENV = {
  CDMON_FTP_HOST: "ftp.example.invalid",
  CDMON_FTP_USER: "example-user",
  CDMON_FTP_PASS: "example-password",
} as const;

/** A complete phpMyAdmin half. */
export const PMA_ENV = {
  CDMON_PMA_URL: "https://pma.example.invalid",
  CDMON_PMA_USER: "example-user",
  CDMON_PMA_PASS: "example-password",
  CDMON_PMA_DB: "example_db",
} as const;

/**
 * Build an environment for loadConfig.
 *
 * The real process.env is never passed to the tests, so a developer's own CDMON_* variables
 * cannot leak in and change what a test asserts.
 */
export function env(...parts: Array<Record<string, string>>): NodeJS.ProcessEnv {
  return Object.assign({}, ...parts) as NodeJS.ProcessEnv;
}

/**
 * A phpMyAdmin dump preamble, in the shape the real export writes it.
 *
 * It carries the three cases a naive splitter gets wrong: an executable /*! directive, a
 * semicolon inside a value, and a doubled quote.
 */
export const DUMP_FIXTURE = [
  "-- phpMyAdmin SQL Dump",
  "-- version 5.2.1",
  "",
  "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
  "/*!40101 SET NAMES utf8mb4 */;",
  "",
  "CREATE TABLE `notes` (",
  "  `id` int(11) NOT NULL AUTO_INCREMENT,",
  "  `body` text NOT NULL,",
  "  PRIMARY KEY (`id`)",
  ");",
  "",
  "INSERT INTO `notes` (`body`) VALUES ('one; two'), ('it''s fine');",
  "",
  "/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;",
].join("\n");

/** How many executable statements DUMP_FIXTURE holds, comments excluded. */
export const DUMP_STATEMENT_COUNT = 5;
