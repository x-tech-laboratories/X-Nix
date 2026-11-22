import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      thresholds: {
        autoUpdate: (new_threshold) => Math.floor(new_threshold),
        lines: 73,
        statements: 70,
        functions: 60,
        branches: 62,
      },
    },
  },
});
