import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server_port = Number(process.env.PORT ?? 7720);

export default defineConfig({
  root: "src/web",
  plugins: [react()],
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
});
