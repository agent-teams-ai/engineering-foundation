import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSourceDependenciesCapability } from "../packages/engineering-foundation/dist/capabilities/source-dependencies/module.js";
import { sourceDependencyAdapters } from "./support/capability-adapters.mjs";
const repositoryRoot = resolve(import.meta.dirname, "..");
export function registerRepositoryBoundaryGuidanceTests(): void {
  void test("source dependency capability accepts the exact repository allowlist", async () => {
    const report = await createSourceDependenciesCapability(sourceDependencyAdapters()).run({
      consumerRoot: repositoryRoot,
      configPath: "architecture/foundation/source-dependencies.yaml",
    });
    assert.equal(report.outcome, "passed", JSON.stringify(report, null, 2));
  });

  void test("current authoring guidance uses only the unified explicit-mutation CLI", async () => {
    for (const path of [
      "README.md",
      "docs/architecture/document-authoring-protocol.md",
      "packages/engineering-foundation/README.md",
    ]) {
      const source = await readFile(join(repositoryRoot, path), "utf8");
      assert.doesNotMatch(source, /agent-teams-foundation docs/u, path);
      assert.doesNotMatch(source, /without `--dry-run`/u, path);
      assert.match(source, /agent-teams-docs/u, path);
    }
  });
}

export function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function fencedCodeBlocks(source: string): (string | undefined)[] {
  return [...source.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

export const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
