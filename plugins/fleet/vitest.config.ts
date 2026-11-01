import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every test reads the neutral fixture profile unless it sets its own.
export default defineConfig({
  test: { env: { NAVAIGATE_CONSOLE_PROFILE: fileURLToPath(new URL("./fixtures/profile.json", import.meta.url)) } },
});
