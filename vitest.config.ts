import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts", "src/types/**"],
      thresholds: { branches: 80, statements: 80, lines: 80, functions: 80 },
    },
  },
});
