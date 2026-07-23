import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The lib is consumed via a `file:..` symlink; its realpath is the repo
    // root, whose own node_modules would otherwise supply a SECOND copy of
    // react (hooks explode) and of the SDK. Force everything onto the demo's.
    dedupe: ["react", "react-dom", "@a2a-js/sdk", "@johnhenry/agent-query-core"],
  },
  server: {
    fs: { allow: [".."] },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.tsx"],
    testTimeout: 15000,
    server: {
      // Externalized deps resolve with plain Node rules, which would find the
      // symlinked lib's OWN react copy; inlining routes them through Vite's
      // resolver so `dedupe` applies in tests too.
      deps: { inline: [/@johnhenry\//] },
    },
  },
});
