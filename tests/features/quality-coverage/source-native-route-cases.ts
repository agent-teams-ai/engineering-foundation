import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sourceRoot } from "./source-observation-fixture.ts";
import {
  qualityReport,
  type QualityTextPut,
  type QualityCliInvoke,
  type QualityFixtureProfile,
} from "./quality-cli-fixture.ts";

export async function qualifyNativeRoutes({
  root,
  put,
  invoke,
  profile,
  scripts,
}: {
  root: string;
  put: QualityTextPut;
  invoke: QualityCliInvoke;
  profile: QualityFixtureProfile;
  scripts: Readonly<Record<string, string>>;
}) {
  const nativePath = `${sourceRoot}/native/helper.c`;
  const nativeScript = "scripts/architecture/native-quality.mjs";
  const nativeProfile = {
    ...profile,
    nativeChecks: [{ boundaryId: "worker", script: "native:check" }],
  };
  // The real nested consumer uses these product/lint chains. A scoped native
  // script is additive wiring; quality coverage does not execute product tests.
  const nativeScripts = {
    ...scripts,
    check: "pnpm product:check && pnpm lint && pnpm native:check",
    lint: "pnpm lint:typed",
    "product:build": "tsc --build",
    "product:check":
      "pnpm --filter './packages/**' -r run clean && pnpm product:build && pnpm --filter './packages/**' -r run test",
    "native:check": "node scripts/architecture/../architecture/native-quality.mjs",
  };
  // Static qualification proves wiring only: this consumer leaf must never execute here.
  await put(nativeScript, "throw new Error('native execution belongs to the consumer gate');\n");
  await put(nativePath, "int helper(void) { return 0; }\n");
  await put("quality.yaml", JSON.stringify(nativeProfile));
  await put(
    "package.json",
    JSON.stringify({ name: "fixture-root", private: true, scripts: nativeScripts }),
  );
  assert.equal((await invoke(["check", "quality.source-coverage"])).code, 0);
  const dispatcher = ".tools/native-dispatch.ts";
  await put(
    dispatcher,
    "throw new Error('static Host readability never authenticates execution');\n",
  );
  const hostScripts = { ...nativeScripts, "native:check": `node ${dispatcher} tool native:check` };
  await put("package.json", JSON.stringify({ scripts: hostScripts }));
  assert.equal(
    (await invoke(["check", "quality.source-coverage"])).code,
    0,
    "a readable static Host dispatcher establishes only the native declaration",
  );
  await rm(join(root, dispatcher));
  assert.equal(
    (await invoke(["check", "quality.source-coverage"])).code,
    2,
    "a missing Host dispatcher rejects before native qualification",
  );
  await put("package.json", JSON.stringify({ scripts: nativeScripts }));
  for (const command of [
    undefined,
    "true",
    "true || node scripts/architecture/native-quality.mjs",
  ]) {
    await put(
      "package.json",
      JSON.stringify({ scripts: { ...nativeScripts, "native:check": command } }),
    );
    const rejected = await invoke(["check", "quality.source-coverage"]);
    assert.equal(rejected.code, 1, rejected.stdout || rejected.stderr);
    assert.ok(
      qualityReport(rejected.stdout).capabilities[0].diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.native-route" && location.path === nativePath,
      ),
    );
  }
  await put(
    "package.json",
    JSON.stringify({ scripts: { ...nativeScripts, check: scripts.check } }),
  );
  const unreachableNative = await invoke(["check", "quality.source-coverage"]);
  assert.equal(unreachableNative.code, 1, unreachableNative.stdout || unreachableNative.stderr);
  assert.ok(
    qualityReport(unreachableNative.stdout).capabilities[0].diagnostics.some(
      ({ ruleId, location }) =>
        ruleId === "quality.source-coverage.native-route" && location.path === nativePath,
    ),
  );
  await put("package.json", JSON.stringify({ scripts: nativeScripts }));
  await rm(join(root, nativeScript));
  assert.equal((await invoke(["check", "quality.source-coverage"])).code, 2);
  await put(nativeScript, "throw new Error('native execution belongs to the consumer gate');\n");
  for (const nativeChecks of [
    [],
    [...nativeProfile.nativeChecks, { boundaryId: "worker", script: "other:check" }],
  ]) {
    await put("quality.yaml", JSON.stringify({ ...profile, nativeChecks }));
    const rejected = await invoke(["check", "quality.source-coverage"]);
    assert.equal(rejected.code, 1, rejected.stdout || rejected.stderr);
    assert.ok(
      qualityReport(rejected.stdout).capabilities[0].diagnostics.some(
        ({ ruleId, location }) =>
          ruleId === "quality.source-coverage.native-route" && location.path === nativePath,
      ),
    );
  }
  await put(
    "quality.yaml",
    JSON.stringify({
      ...profile,
      nativeChecks: [{ boundaryId: "unknown", script: "native:check" }],
    }),
  );
  assert.equal((await invoke(["check", "quality.source-coverage"])).code, 2);
  await put("quality.yaml", JSON.stringify(nativeProfile));
  await rm(join(root, nativePath));
  const staleNative = await invoke(["check", "quality.source-coverage"]);
  assert.equal(staleNative.code, 2, staleNative.stdout || staleNative.stderr);
  assert.match(
    qualityReport(staleNative.stdout).capabilities[0].problem!.message,
    /no current native source/u,
  );
  await put("quality.yaml", JSON.stringify(profile));
  await put("package.json", JSON.stringify({ name: "fixture-root", private: true, scripts }));
  await rm(join(root, nativeScript));
  return { nativePath, nativeProfile, nativeScript, nativeScripts };
}
