import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { PUBLISHABLE_PACKAGES } from "../scripts/publishable-packages.mjs";
import { sourceFiles } from "./package-boundary-support.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const dependencySections = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
];
const names = Object.freeze({
  adapter: "@agent-teams/docs-protocol-agent-teams",
  authoring: "@agent-teams/document-authoring",
  docs: "@agent-teams/docs-protocol",
  foundation: "@agent-teams/engineering-foundation",
  mcp: "@agent-teams/docs-protocol-mcp",
  mutation: "@agent-teams/repository-mutation",
});

async function manifest(slug) {
  return JSON.parse(await readFile(
    join(repositoryRoot, "packages", slug, "package.json"),
    "utf8",
  ));
}

function internalDependencies(value) {
  const publicNames = new Set(PUBLISHABLE_PACKAGES.map(({ name }) => name));
  return dependencySections.flatMap((section) =>
    Object.keys(value[section] ?? {}).filter((name) => publicNames.has(name)))
    .toSorted();
}

test("manifests expose exactly the closed ADR-0043 package DAG", async () => {
  const manifests = new Map(await Promise.all([
    "repository-mutation", "document-authoring", "engineering-foundation",
    "docs-protocol", "docs-protocol-agent-teams", "docs-protocol-mcp",
  ].map(async (slug) => {
    const value = await manifest(slug);
    return [value.name, value];
  })));
  const expected = new Map([
    [names.mutation, []],
    [names.authoring, [names.mutation]],
    [names.foundation, [names.authoring, names.mutation].toSorted()],
    [names.docs, [names.authoring, names.mutation].toSorted()],
    [names.adapter, [names.docs, names.mutation].toSorted()],
    [names.mcp, [names.docs]],
  ]);
  assert.deepEqual([...manifests.keys()].toSorted(), [...expected.keys()].toSorted());
  for (const [name, dependencies] of expected) {
    assert.deepEqual(internalDependencies(manifests.get(name)), dependencies, name);
  }
});

test("new-only cutover has no Foundation/Document Authoring backchannel", async () => {
  const foundation = await manifest("engineering-foundation");
  assert.equal(foundation.exports?.["./document-authoring"], undefined);
  assert.equal(foundation.exports?.["./document-authoring/qualification"], undefined);

  const authoringSources = await sourceFiles(join(
    repositoryRoot, "packages", "document-authoring", "src",
  ));
  for (const path of authoringSources) {
    assert.doesNotMatch(await readFile(path, "utf8"),
      /(?:from\s+|import\s*\()["']@agent-teams\/engineering-foundation(?:\/[^"']*)?["']/u,
      `${path} cannot import Foundation`);
  }

  const foundationSources = await sourceFiles(join(
    repositoryRoot, "packages", "engineering-foundation", "src",
  ));
  for (const path of foundationSources) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source,
      /from\s+["']\.\.?\/document-authoring/u,
      `${path} cannot retain a private authoring facade`);
  }

  for (const slug of [
    "repository-mutation", "document-authoring", "engineering-foundation",
    "docs-protocol", "docs-protocol-agent-teams", "docs-protocol-mcp",
  ]) {
    for (const path of await sourceFiles(join(repositoryRoot, "packages", slug, "src"))) {
      assert.doesNotMatch(await readFile(path, "utf8"),
        /(?:from\s+|import\s*\()["']@agent-teams\/engineering-foundation\/document-authoring(?:\/[^"']*)?["']/u,
        `${path} cannot import the removed Foundation authoring export`);
    }
  }
});

test("removed Foundation authoring package paths stay physically absent", async () => {
  for (const path of [
    "packages/engineering-foundation/dist/document-authoring/index.js",
    "packages/engineering-foundation/dist/documentation-observation/index.js",
  ]) {
    await assert.rejects(
      access(join(repositoryRoot, path)),
      (error) => error?.code === "ENOENT",
      path,
    );
  }
});
