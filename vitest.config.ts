import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests that need a server run against the containers in tests/testserver,
    // not against a real account. Nothing here should ever touch a live site.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
