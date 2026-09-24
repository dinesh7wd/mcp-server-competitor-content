import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/engines/**", "src/services/**"],
      thresholds: { branches: 80 },
    },
  },
});
