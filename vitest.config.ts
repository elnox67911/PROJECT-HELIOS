import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@helios/core": r("./packages/core/src/index.ts"),
      "@helios/core/": r("./packages/core/src/"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
