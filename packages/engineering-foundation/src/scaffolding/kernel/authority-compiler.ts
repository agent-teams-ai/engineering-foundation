import type {
  JsonValue,
  AuthorityScaffoldCompilationInput,
  AuthorityScaffoldReadSet,
  ScaffoldAuthorityVerifierV1,
  AuthorityScaffoldPlan
} from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import { sha256Json } from "./canonical-json.js";
import { assertAuthorityEvidenceSourceBindings } from "./authority-evidence.js";
import {
  compileScaffoldRendering,
  resolveScaffoldRenderingSelection,
  type ScaffoldRenderingResult
} from "./compiler.js";
import type { ScaffoldDefinitionRegistry } from "./definition-registry.js";

function assertVerifierAdmission(
  input: AuthorityScaffoldCompilationInput,
  composition: AuthorityScaffoldCompilationInput["config"]["compositions"][number],
  target: AuthorityScaffoldCompilationInput["catalog"]["packages"][number]
): void {
  const authorityVerifiers = composition.authorityVerifiers as readonly ScaffoldAuthorityVerifierV1[];
  if (authorityVerifiers.length !== 1) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The selected Composition must contain exactly one supported authority verifier."
    );
  }
  const admittedVerifier = authorityVerifiers[0];
  if (admittedVerifier === undefined) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The selected Composition must admit exactly one authority verifier."
    );
  }
  if (
    !admittedVerifier.parameters.allowedStatuses.includes(
      input.authorityEvidence.ownerDocument.status
    )
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Owner document status is not allowed by the selected Composition."
    );
  }
  assertAuthorityEvidenceSourceBindings({
    evidence: input.authorityEvidence,
    target,
    projectId: input.config.projectId,
    targetRef: input.intent.targetRef,
    configPath: input.configPath,
    targetCatalogPath: input.config.targetCatalogPath,
    authorityReadSet: input.authorityReadSet
  });
}

function normalizeAuthorityPlan(
  input: AuthorityScaffoldCompilationInput,
  rendering: ScaffoldRenderingResult,
  composition: AuthorityScaffoldCompilationInput["config"]["compositions"][number],
  target: AuthorityScaffoldCompilationInput["catalog"]["packages"][number]
): AuthorityScaffoldPlan {
  const authoritySnapshotDigest = sha256Json({
    configPath: input.configPath,
    projectId: input.config.projectId,
    composition,
    target,
    authorityEvidence: input.authorityEvidence,
    readSet: input.authorityReadSet
  } as unknown as JsonValue);
  const planBody = {
    schemaVersion: 2 as const,
    protocolVersion: 2 as const,
    ...rendering,
    projectId: input.config.projectId,
    authority: Object.freeze({
      configPath: input.configPath,
      targetCatalogPath: input.config.targetCatalogPath
    }),
    authorityEvidence: input.authorityEvidence,
    authoritySnapshotDigest,
    target,
    readSet: Object.freeze(
      [...input.authorityReadSet].toSorted((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      )
    ) as AuthorityScaffoldReadSet,
    requiredAdapterCapabilities: ["materialize-file/v1"] as const
  };
  return Object.freeze({
    ...planBody,
    planDigest: sha256Json(planBody as unknown as JsonValue)
  });
}

export function compileAuthorityScaffoldPlan(
  input: AuthorityScaffoldCompilationInput,
  registry: ScaffoldDefinitionRegistry
): AuthorityScaffoldPlan {
  const { composition, target } = resolveScaffoldRenderingSelection({
    compositions: input.config.compositions,
    targets: input.catalog.packages,
    authorityReadPaths: input.authorityReadSet.map(({ path }) => path),
    intent: input.intent
  });
  assertVerifierAdmission(input, composition, target);
  const rendering = compileScaffoldRendering(
    {
      foundationVersion: input.foundationVersion,
      intent: input.intent,
      composition,
      target: {
        id: target.id,
        role: target.role,
        path: target.path,
        packageName: target.packageName
      }
    },
    registry
  );
  return normalizeAuthorityPlan(input, rendering, composition, target);
}
