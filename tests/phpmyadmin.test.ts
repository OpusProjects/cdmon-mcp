/**
 * The two pieces of the phpMyAdmin session that can be checked without a server.
 *
 * Both matter more than they look. Getting either wrong raises no error: the server answers
 * with a page regardless, and the mistake surfaces one request later as a missing token,
 * which reads exactly like a wrong password.
 */

import { describe, expect, it } from "vitest";
import { buildUrl, loginForm } from "../src/phpmyadmin.js";
import type { PmaConfig } from "../src/config.js";

const BASE = "https://pma.example.invalid";

function cfg(domain: string | null): PmaConfig {
  return {
    url: BASE,
    user: "example-user",
    password: "example-password",
    database: "example_db",
    domain,
    timeoutMs: 30000,
  };
}

describe("buildUrl", () => {
  it("leaves the URL alone when there is no domain to select", () => {
    expect(buildUrl(BASE, "/index.php", null)).toBe(`${BASE}/index.php`);
    expect(buildUrl(BASE, "/index.php?route=/import", null)).toBe(`${BASE}/index.php?route=/import`);
  });

  it("appends the selector with ? when the path has no query", () => {
    expect(buildUrl(BASE, "/index.php", "site.example")).toBe(`${BASE}/index.php?d=site.example`);
  });

  it("appends the selector with & when the path already has a query", () => {
    // Using ? twice produces a URL where the server sees no route at all.
    expect(buildUrl(BASE, "/index.php?route=/import", "site.example")).toBe(
      `${BASE}/index.php?route=/import&d=site.example`,
    );
  });

  it("encodes a domain that needs it", () => {
    expect(buildUrl(BASE, "/index.php", "a b&c.example")).toBe(
      `${BASE}/index.php?d=a%20b%26c.example`,
    );
  });
});

describe("loginForm", () => {
  it("sends server=1 on a stock install, and no domain fields", () => {
    const form = loginForm(cfg(null));
    expect(form.get("server")).toBe("1");
    expect(form.get("pma_domain")).toBeNull();
    expect(form.get("lang")).toBeNull();
  });

  it("sends the domain instead of a server number when one is configured", () => {
    // A shared phpMyAdmin resolves the server from the domain. Naming server 1 as well
    // would point at a server this account may not have.
    const form = loginForm(cfg("site.example"));
    expect(form.get("pma_domain")).toBe("site.example");
    expect(form.get("route")).toBe("/");
    expect(form.get("server")).toBeNull();
  });

  it("pins the interface language when a domain is used", () => {
    // The response is read by matching English strings and classes, so letting the server
    // pick the language from the request would make the parsing fail in another locale.
    expect(loginForm(cfg("site.example")).get("lang")).toBe("en");
  });

  it("always carries the credentials", () => {
    for (const domain of [null, "site.example"]) {
      const form = loginForm(cfg(domain));
      expect(form.get("pma_username")).toBe("example-user");
      expect(form.get("pma_password")).toBe("example-password");
    }
  });
});
