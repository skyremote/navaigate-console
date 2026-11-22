// bb installs a plugin from Git with `npm install --omit=dev`, and it bundles the SDK
// entries it does not provide itself (the SDK root in the page bundle,
// "@get-bb/plugin-sdk/provider-bridge" in the host bundle) from the plugin's own
// install. So the SDK must sit under dependencies, or a Git install stops with:
// Could not resolve "@get-bb/plugin-sdk".
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the SDK is a dependency, so a Git install can build the page and host bundles", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  expect(pkg.dependencies["@get-bb/plugin-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(pkg.devDependencies["@get-bb/plugin-sdk"]).toBeUndefined();
});
