import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The demo app has its own vitest run (`npm test` in demo/); keep it out of ours.
    exclude: [...configDefaults.exclude, "demo/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { statements: 85 },
    },
  },
});
