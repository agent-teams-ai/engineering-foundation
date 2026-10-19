import { isDeepStrictEqual } from 'node:util';
import { observeNativeMigration as observeShared } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/observe-native-tool-transition.js';
import { assertSchema } from '../packages/engineering-foundation/dist/schema-catalog.js';
import { readAcceptedArchitectureDecisionEvidence } from '../packages/engineering-foundation/dist/capabilities/governance-architecture-decisions/module.js';
import { createPublicApiArtifactDependencies, createPublicApiCompatibilityDependencies } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/module.js';
import { AjvJsonSchemaReleaseInspector } from '../packages/engineering-foundation/dist/capabilities/contract-json-schema-releases/module.js';
import { readContainedRegularFile, pathTraversesSymbolicLink } from '../packages/engineering-foundation/dist/source-inventory/node.js';
export { migrationBytes, migrationDigest } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/native-tool-transition-content.js';
export { nativeMigrationFrom, nativeMigrationTo, nativeMigrationToolDifference } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js';
export type { NativeMigrationObservation, NativeMigrationPackageInput, NativeMigrationPackageObservation, NativeMigrationToolDifference, MigrationDigest } from '../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/native-tool-transition.js';
export const nativeMigrationPackageNames: readonly string[] = Object.freeze(['ci-input-proof', 'docs-protocol', 'docs-protocol-agent-teams', 'docs-protocol-mcp', 'document-authoring', 'engineering-foundation', 'feature-module-standard', 'repository-mutation'].map(name => `@agent-teams/${name}`).toSorted());
export async function observeNativeMigration(options: Parameters<typeof observeShared>[0]) {
 const input = {consumerRoot: options.consumerRoot, releasedRoot: options.releasedRoot, policy: structuredClone(options.policy), packages: structuredClone(options.packages), ...(options.signal === undefined ? {} : {signal: options.signal})};
 for (const names of [input.policy.packages.map(p => p.packageName), input.packages.map(p => p.packageName)]) {
  if (!isDeepStrictEqual(names.toSorted(), nativeMigrationPackageNames)) { throw new Error('Native public API migration: exact governed eight-package inventory is required'); }
 }
 const typed = createPublicApiCompatibilityDependencies(i => readAcceptedArchitectureDecisionEvidence(i, assertSchema), assertSchema);
 return observeShared(input, {typed, artifacts: () => createPublicApiArtifactDependencies(input.consumerRoot, input.policy.packages, typed, new AjvJsonSchemaReleaseInspector({read: readContainedRegularFile}), input.signal), evidence: {files: {read: readContainedRegularFile}, paths: {traversesSymbolicLink: pathTraversesSymbolicLink}}, assertSchema});
}
