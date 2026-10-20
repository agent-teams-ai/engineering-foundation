import { loadCapabilityConfig, type PublicApiConfigurationDependencies } from './adapters/inbound/configuration/load-capability-config.js';
import { readContainedRegularFile, pathTraversesSymbolicLink } from '../../source-inventory/node.js';
import { parseStrictYamlSource } from '../../features/configuration-input/yaml.js';
import { loadStrictYamlFile } from '../../features/configuration-input/node.js';
import { loadNativeTransitionRequest, type NativeTransitionSchemaAssertion } from './adapters/inbound/configuration/load-native-tool-transition.js';
import { observeNativeMigration } from './adapters/outbound/filesystem/observe-native-tool-transition.js';
import { createNativeTransitionContent, migrationBytes, migrationDigest, assertPhysicalNativeBaselines } from './adapters/outbound/filesystem/native-tool-transition-content.js';
import { assertNativeMigrationReview } from './application/policies/validate-native-tool-transition.js';
import { prepareNativeMigrationPromotion } from './application/use-cases/prepare-native-tool-transition.js';
import { nativeTransitionError as fail } from './application/model/native-tool-transition.js';
import { createPublicApiCompatibilityDependencies, createPublicApiArtifactDependencies } from './module.js';
import type { AcceptedArchitectureDecisionReader } from './application/ports/accepted-decision-evidence.js';
import type { JsonSchemaSetInspector } from './application/ports/package-artifact-inventory.js';
/** Content qualification and release promotion use the same supported edge.
 * No input value grants authority to run the existing release-owned writer. */
export async function runNativePublicApiTransition(options: { readonly consumerRoot: string; readonly configPath: string; readonly requestPath: string; readonly qualificationOnly: boolean; readonly signal?: AbortSignal }, readAccepted: AcceptedArchitectureDecisionReader, assertSchema: PublicApiConfigurationDependencies['assertSchema'] & NativeTransitionSchemaAssertion, inspector: JsonSchemaSetInspector, beforeApply?: () => Promise<void>) {
 const input = {...options};
 const evidence = {files: {read: readContainedRegularFile}, paths: {traversesSymbolicLink: pathTraversesSymbolicLink}, parseYaml: parseStrictYamlSource};
 const content = createNativeTransitionContent(evidence);
 const policy = await loadCapabilityConfig({readYaml: loadStrictYamlFile, assertSchema}, input.consumerRoot, input.configPath, input.signal);
 if (policy.schemaVersion !== 1) { fail('native transition requires the ordinary v1 compatibility policy'); }
 const request = await loadNativeTransitionRequest(input.consumerRoot, input.requestPath, assertSchema, evidence);
 // An apply may be resuming exact postimages. Qualification always binds B.
 if (input.qualificationOnly) { await assertPhysicalNativeBaselines({...input, policy, review: request.review}, content); }
 const typed = createPublicApiCompatibilityDependencies(readAccepted, assertSchema);
 const artifacts = () => createPublicApiArtifactDependencies(input.consumerRoot, policy.packages, typed, inspector, input.signal);
 const observation = await observeNativeMigration({...input, ...request, policy}, {typed, artifacts, evidence, assertSchema});
 assertNativeMigrationReview(observation, request.review, policy, content);
 await assertPhysicalNativeBaselines({...input, policy, review: request.review, ...(input.qualificationOnly ? {} : {observation})}, content);
 if (input.qualificationOnly && (observation.typedDiagnostics.length !== 0 || observation.artifactDiagnostics.length !== 0)) { fail('native candidate compatibility is incomplete or rejected'); }
 const common = {schemaVersion: 1 as const, kind: 'foundation:public-api-native-transition:result:1' as const, observation, observationDigest: migrationDigest(migrationBytes(observation)), reviewDigest: migrationDigest(migrationBytes(request.review))};
 if (input.qualificationOnly) { return {...common, outcome: 'qualified' as const, migrationApplied: false as const, writes: []}; }
 const plan = await prepareNativeMigrationPromotion({...input, policy, observation, review: request.review}, {typed, artifacts: await artifacts(), content});
 await beforeApply?.();
 await plan.apply();
 return {...common, outcome: 'promoted' as const, migrationApplied: true as const, writes: plan.writes};
}
