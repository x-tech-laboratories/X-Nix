import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const server_port = Number(process.env.PORT ?? 7720);

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    // The dev page reaches the API through the separately running server; the pattern leaves the page's own api.ts alone.
    proxy: {
      "^/api/": `http://127.0.0.1:${server_port}`,
    },
  },
  test: {
    // Tests live in tests/, outside the web page's root.
    root: import.meta.dirname,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // The floor only rises: a run above it raises it to the whole percent below, to be committed.
      thresholds: {
        autoUpdate: (new_threshold) => Math.floor(new_threshold),
        lines: 73,
        statements: 70,
        functions: 60,
        branches: 63,
      },
    },
  },
});
