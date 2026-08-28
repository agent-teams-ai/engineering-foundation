import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectDocumentAuthoringEnvironmentV1 } from "@agent-teams/engineering-foundation/document-authoring";

import { DOCS_ADOPTION_MAX_MANIFEST_BYTES } from "../domain/model.js";
import { parseJsonRecord, readRealRegularText } from "./adoption-input.js";

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
export const DOCS_PACKAGE = "@agent-teams/docs-protocol";
export const FOUNDATION_PACKAGE = "@agent-teams/engineering-foundation";
const executingDocsManifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const executingFoundationManifestPath = createRequire(import.meta.url).resolve(`${FOUNDATION_PACKAGE}/package.json`);

function packageVersion(manifest: Record<string, unknown>, expectedName: string): string {
  if (manifest["name"] !== expectedName || typeof manifest["version"] !== "string" || !EXACT_VERSION.test(manifest["version"])) {
    throw new Error(`Executing ${expectedName} manifest has an invalid identity.`);
  }
  return manifest["version"];
}

function resolvedManifest(root: string, packageName: string): string {
  return resolve(createRequire(join(root, "package.json")).resolve(`${packageName}/package.json`));
}

export async function inspectAdoptionPackageIdentity(
  root: string,
  devDependencies: Readonly<Record<string, unknown>>
): Promise<readonly { readonly message: string; readonly subject: string }[]> {
  const diagnostics: { message: string; subject: string }[] = [];
  try {
    const consumerDocsManifestPath = resolvedManifest(root, DOCS_PACKAGE);
    const consumerFoundationManifestPath = resolvedManifest(root, FOUNDATION_PACKAGE);
    const [docsManifest, foundationManifest] = await Promise.all([
      readRealRegularText(executingDocsManifestPath, DOCS_ADOPTION_MAX_MANIFEST_BYTES).then(parseJsonRecord),
      readRealRegularText(executingFoundationManifestPath, DOCS_ADOPTION_MAX_MANIFEST_BYTES).then(parseJsonRecord)
    ]);
    const docsVersion = packageVersion(docsManifest, DOCS_PACKAGE);
    const foundationVersion = packageVersion(foundationManifest, FOUNDATION_PACKAGE);
    if (devDependencies[DOCS_PACKAGE] !== docsVersion) {diagnostics.push({ subject: "package.json#devDependencies", message: `${DOCS_PACKAGE} must be pinned exactly to the executing version ${docsVersion}.` });}
    if (devDependencies[FOUNDATION_PACKAGE] !== foundationVersion) {diagnostics.push({ subject: "package.json#devDependencies", message: `${FOUNDATION_PACKAGE} must be pinned exactly to the executing Foundation version ${foundationVersion}.` });}
    const [consumerDocs, executingDocs, consumerFoundation, executingFoundation] = await Promise.all([
      realpath(consumerDocsManifestPath),
      realpath(executingDocsManifestPath),
      realpath(consumerFoundationManifestPath),
      realpath(executingFoundationManifestPath)
    ]);
    if (consumerDocs !== executingDocs) {diagnostics.push({ subject: "node_modules/@agent-teams/docs-protocol", message: "Consumer resolution must select the physical Docs Protocol package currently executing." });}
    if (consumerFoundation !== executingFoundation) {diagnostics.push({ subject: "node_modules/@agent-teams/engineering-foundation", message: "Consumer resolution must select the same physical Foundation build loaded by Docs Protocol." });}
    try {
      const environment = await inspectDocumentAuthoringEnvironmentV1({ consumerRoot: root });
      if (environment.installedFoundationVersion !== foundationVersion) {diagnostics.push({ subject: "foundation.environment", message: `Foundation environment version ${environment.installedFoundationVersion} does not match the executing manifest version ${foundationVersion}.` });}
      if (!DIGEST.test(environment.installedFoundationBuildIdentity)) {diagnostics.push({ subject: "foundation.environment", message: "Executing Foundation did not report a valid build identity." });}
    } catch (error) {
      diagnostics.push({ subject: "foundation.environment", message: `Executing Foundation environment inspection failed: ${error instanceof Error ? error.message : "invalid environment"}` });
    }
  } catch (error) {
    diagnostics.push({ subject: "node_modules/@agent-teams", message: `Exact installed Docs Protocol and Foundation identities are required: ${error instanceof Error ? error.message : "invalid installation"}` });
  }
  return Object.freeze(diagnostics);
}
