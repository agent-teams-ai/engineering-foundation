import { registerInternalStageResolutionTest } from "./pack-internal-stage-resolution-cases.ts";
import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCleanBuildStage } from "../scripts/pack-artifact-e2e.mjs";
import { runCommand } from "../scripts/pack-test-support.mjs";

const insertDuplicateKey = (sourceText, marker, insertion, atRoot = false) => {
  const position = sourceText.indexOf(marker);
  if (atRoot) {
    assert.equal(position, 0, "root object marker must be at the start");
    assert.ok(sourceText.startsWith("{\n"), "root object must start with a newline");
  } else {
    assert.ok(position > 0, `expected nested marker ${marker}`);
    assert.equal(
      sourceText.lastIndexOf(marker),
      position,
      `nested marker ${marker} must be unique`,
    );
  }
  const end = position + marker.length;
  return sourceText.slice(0, end) + insertion + sourceText.slice(end);
};

export function registerCleanBuildStageTests() {
  registerInternalStageResolutionTest();
  test("managed policy clean build uses canonical repository inputs and rejects missing or stale inputs", async (t) => {
    const sourceRepositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const repositoryRoot = await mkdtemp(join(tmpdir(), "pack-managed-policy-"));
    t.after(() => rm(repositoryRoot, { force: true, recursive: true }));
    const packageName = "@agent-teams/docs-protocol-agent-teams";
    const packageRoot = join(repositoryRoot, "packages", "docs-protocol-agent-teams");
    const policyPath = "architecture/foundation/docs-protocol-current-policy-v3.json";
    const schemaPath = "architecture/contracts/docs-protocol-current-policy/v3.schema.json";
    const copies = [
      policyPath,
      schemaPath,
      "packages/docs-protocol-agent-teams/scripts/generate-runtime-policy.mjs",
      "packages/docs-protocol-agent-teams/scripts/runtime-policy-input-paths.mjs",
      "packages/docs-protocol-agent-teams/assets/runtime-policy.v1.json",
      "packages/docs-protocol-agent-teams/schemas/managed-runtime-policy/v1.schema.json",
    ];
    for (const path of copies) {
      await mkdir(dirname(join(repositoryRoot, path)), { recursive: true });
      await copyFile(join(sourceRepositoryRoot, path), join(repositoryRoot, path));
    }
    const installedAjv = join(sourceRepositoryRoot, "node_modules", "ajv");
    const ajvVersion = JSON.parse(
      await readFile(join(installedAjv, "package.json"), "utf8"),
    ).version;
    const installedJsonc = join(
      sourceRepositoryRoot,
      "packages",
      "docs-protocol-agent-teams",
      "node_modules",
      "jsonc-parser",
    );
    const jsoncVersion = JSON.parse(
      await readFile(join(installedJsonc, "package.json"), "utf8"),
    ).version;
    await mkdir(join(packageRoot, "node_modules"), { recursive: true });
    await symlink(await realpath(installedAjv), join(packageRoot, "node_modules", "ajv"), "dir");
    await symlink(
      await realpath(installedJsonc),
      join(packageRoot, "node_modules", "jsonc-parser"),
      "dir",
    );
    await writeFile(join(repositoryRoot, "LICENSE"), "fixture license\n");
    await writeFile(join(repositoryRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(join(packageRoot, "README.md"), "# Managed policy build fixture\n");
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: packageName,
        version: "0.0.0",
        type: "module",
        dependencies: { ajv: ajvVersion, "jsonc-parser": jsoncVersion },
        files: ["assets", "schemas"],
      })}\n`,
    );

    const stage = (label) =>
      createCleanBuildStage(
        {
          artifactLabel: "managed-policy",
          dependencyDeclarations: { [packageName]: [] },
          packageName,
          repositoryRoot,
          runBuild: async (stagedPackageRoot) => {
            await runCommand(
              process.execPath,
              [join(stagedPackageRoot, "scripts", "generate-runtime-policy.mjs")],
              stagedPackageRoot,
            );
          },
          stagePackages: [
            {
              name: packageName,
              root: "packages/docs-protocol-agent-teams",
              sourceRoot: packageRoot,
            },
          ],
          temporaryRoot: repositoryRoot,
        },
        label,
      );

    const valid = await stage("valid");
    for (const path of [policyPath, schemaPath]) {
      const stagedPath = join(valid.stageRoot, path);
      assert.deepEqual(await readFile(stagedPath), await readFile(join(repositoryRoot, path)));
      assert((await lstat(stagedPath)).isFile());
      assert.notEqual(await realpath(stagedPath), await realpath(join(repositoryRoot, path)));
    }
    for (const path of [policyPath, schemaPath]) {
      const source = join(repositoryRoot, path);
      const original = await readFile(source);
      await rm(source);
      await assert.rejects(
        stage(`missing-${path === policyPath ? "policy" : "schema"}`),
        /ENOENT/u,
      );
      await writeFile(source, original);
    }

    const policySource = join(repositoryRoot, policyPath);
    const originalPolicy = await readFile(policySource);
    const alias = join(repositoryRoot, "policy-alias.json");
    await writeFile(alias, originalPolicy);
    await rm(policySource);
    await symlink(alias, policySource);
    await assert.rejects(stage("aliased-policy"), /not the canonical repository file/u);
    await rm(policySource);
    await writeFile(policySource, originalPolicy);

    for (const [path, nested, key, escapedKey, nestedKey] of [
      [policyPath, '\n  "runtime": {', "policyId", "policy\\u0049d", "productionDefault"],
      [schemaPath, '\n  "$defs": {', "$schema", "$sche\\u006da", "currentSchemaSet"],
    ]) {
      const original = await readFile(join(repositoryRoot, path), "utf8");
      assert.ok(original.startsWith("{\n"), `${path} must be checked out with LF line endings`);
      const parsed = JSON.parse(original);
      const nestedValue = path === policyPath ? parsed.runtime[nestedKey] : parsed.$defs[nestedKey];
      assert.equal(JSON.parse(`"${escapedKey}"`), key, `${path} escaped key must decode to ${key}`);
      for (const [scope, changed] of [
        [
          "top",
          insertDuplicateKey(
            original,
            "{",
            `${JSON.stringify(key)}:${JSON.stringify(parsed[key])},`,
            true,
          ),
        ],
        [
          "nested",
          insertDuplicateKey(
            original,
            nested,
            `${JSON.stringify(nestedKey)}:${JSON.stringify(nestedValue)},`,
          ),
        ],
        [
          "escaped",
          insertDuplicateKey(
            original,
            "{",
            `"${escapedKey}":${JSON.stringify(parsed[key])},`,
            true,
          ),
        ],
      ]) {
        assert.notEqual(changed, original, `${path} ${scope} fixture must change`);
        assert.deepEqual(
          JSON.parse(changed),
          parsed,
          `${path} ${scope} must retain the value native parsing would accept`,
        );
        await writeFile(join(repositoryRoot, path), changed);
        await assert.rejects(
          stage(`duplicate-${path === policyPath ? "policy" : "schema"}-${scope}`),
          (error) => {
            assert.match(error.stderr, /duplicate decoded JSON keys/u);
            return true;
          },
        );
      }
      await writeFile(join(repositoryRoot, path), original);
    }
    await writeFile(policySource, `${originalPolicy.toString("utf8")} // JSONC is not JSON`);
    await assert.rejects(stage("jsonc-policy"), (error) => {
      assert.match(error.stderr, /SyntaxError|Unexpected|JSON/u);
      return true;
    });
    await writeFile(policySource, originalPolicy);

    await writeFile(policySource, `${originalPolicy.toString("utf8")}\n`);
    await assert.rejects(stage("altered-policy"), (error) => {
      assert.match(error.stderr, /Packed runtime policy projection or schema is stale/u);
      return true;
    });
    await writeFile(policySource, originalPolicy);

    const schemaSource = join(repositoryRoot, schemaPath);
    const schema = JSON.parse(await readFile(schemaSource, "utf8"));
    schema.properties.policyVersion.const = "fixture-reject";
    await writeFile(schemaSource, `${JSON.stringify(schema)}\n`);
    await assert.rejects(stage("altered-schema"), (error) => {
      assert.match(error.stderr, /Invalid runtime policy source/u);
      return true;
    });
  });
}
