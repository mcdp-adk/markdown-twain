import { defineConfig } from "vitest/config";

// Node's fetch ignores HTTP(S)_PROXY unless this is set when a process starts.
// Setting it here, before vitest forks its workers, makes the live test go
// through the same proxy the extension host uses.
process.env.NODE_USE_ENV_PROXY ??= "1";

export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
  },
});
