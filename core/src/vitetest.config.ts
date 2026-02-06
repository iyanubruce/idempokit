import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["node_modules", "dist", ".idea", ".git", ".cache", "**/*.d.ts"],
    globals: true, // Allows `describe`, `it` without imports
    environment: "node",
    reporters: ["verbose"],
  },
});
