import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ test: { setupFiles: ["tests/setup-profile.ts", "tests/setup-rpc-flight.ts"], include: ["tests/native-*.test.ts", "tests/native-*.test.tsx", "profile/*.test.ts"] }, resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } } });
