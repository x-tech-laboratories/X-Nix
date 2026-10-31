import { defineConfig } from "vitest/config";

const server_port = Number(process.env.PORT ?? 7720);

export default defineConfig({
  root: "src/web",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    // The dev page reaches the API through the separately running server.
    proxy: {
      "/api": `http://127.0.0.1:${server_port}`,
    },
  },
  test: {
    // Tests live in tests/, outside the web page's root.
    root: import.meta.dirname,
    include: ["tests/**/*.test.ts"],
  },
});
