import type {
  ConfiguredDefinition,
  DefinitionRef,
  JsonObject,
  JsonValue,
  ScaffoldRenderingCompiler,
  ScaffoldRenderingComposition,
  ScaffoldRenderingCompositionSelection,
  ScaffoldRenderingDefinitionEvidence,
  ScaffoldRenderingDiagnostic,
  ScaffoldRenderingIntent,
  ScaffoldRenderingOperation,
  ScaffoldRenderingResolution,
  ScaffoldRenderingTarget,
  ScaffoldFileContribution,
  Sha256Digest
} from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  sha256Text
} from "./canonical-json.js";
import {
  ScaffoldDefinitionRegistry,
  type ScaffoldDefinition,
  type ScaffoldDefinitionContext,
  type ScaffoldFacetDefinition
} from "./definition-registry.js";
import {
  MAX_SCAFFOLD_FILE_BYTES,
  MAX_SCAFFOLD_ID_LENGTH,
  MAX_SCAFFOLD_OPERATIONS,
  MAX_SCAFFOLD_TOTAL_BYTES
} from "./limits.js";

function refKey(ref: DefinitionRef): string {
  return `${ref.id}@${ref.contractVersion}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  subject: string
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Duplicate ${subject}: ${identity}.`
      );
    }
    seen.add(identity);
  }
}

function findExactlyOne<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  missingMessage: string
): T {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new ScaffoldError("SCAFFOLD_INPUT_INVALID", missingMessage);
  }
  return matches[0] as T;
}

function mergeRecipeParameters(
  composition: ScaffoldRenderingComposition,
  explicit: JsonObject
): JsonObject {
  const fixed = composition.fixedRecipeParameters ?? {};
  for (const [key, value] of Object.entries(explicit)) {
    const fixedValue = fixed[key];
    if (
      fixedValue !== undefined &&
      canonicalJson(value) !== canonicalJson(fixedValue)
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Recipe parameter ${key} is fixed by composition ${composition.id}.`
      );
    }
  }
  return Object.freeze({
    ...composition.recipe.parameters,
    ...composition.defaultRecipeParameters,
    ...explicit,
    ...fixed
  });
}

function collectPolicies(
  sources: readonly (readonly ConfiguredDefinition[])[]
): readonly ConfiguredDefinition[] {
  const policies = new Map<string, ConfiguredDefinition>();
  for (const source of sources) {
    for (const configured of source) {
      const key = refKey(configured.ref);
      const existing = policies.get(key);
      if (
        existing !== undefined &&
        canonicalJson(existing.parameters ?? {}) !==
          canonicalJson(configured.parameters ?? {})
      ) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          `Required Policy parameters conflict: ${key}.`
        );
      }
      policies.set(key, configured);
    }
  }
  return Object.freeze(
    [...policies.values()].toSorted((left, right) =>
      compareStrings(refKey(left.ref), refKey(right.ref))
    )
  );
}

function selectFacets(
  registry: ScaffoldDefinitionRegistry,
  composition: ScaffoldRenderingComposition,
  explicit: readonly ConfiguredDefinition[] | undefined
): readonly {
  readonly definition: ScaffoldFacetDefinition;
  readonly parameters: JsonObject;
}[] {
  const fixed = composition.facets?.fixed ?? [];
  const selected = explicit ?? composition.facets?.default ?? [];
  const allowed = new Set(
    (composition.facets?.allowed ?? []).map((ref) => refKey(ref))
  );
  assertUnique(
    composition.facets?.allowed ?? [],
    (ref) => refKey(ref),
    "allowed Facet"
  );
  assertUnique(fixed, ({ ref }) => refKey(ref), "fixed Facet");
  assertUnique(selected, ({ ref }) => refKey(ref), "selected Facet");

  const fixedKeys = new Set(fixed.map(({ ref }) => refKey(ref)));
  for (const candidate of selected) {
    const key = refKey(candidate.ref);
    if (fixedKeys.has(key)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Fixed Facet cannot be selected again: ${key}.`
      );
    }
    if (!allowed.has(key)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Facet is not allowed by composition ${composition.id}: ${key}.`
      );
    }
  }

  const resolved = [...fixed, ...selected]
    .map((candidate) => {
      const definition = registry.resolve(candidate.ref, "facet");
      const parameters = candidate.parameters ?? {};
      registry.validateParameters(definition, parameters);
      return Object.freeze({ definition, parameters });
    })
    .toSorted((left, right) =>
      compareStrings(refKey(left.definition.ref), refKey(right.definition.ref))
    );
  const selectedKeys = new Set(
    resolved.map(({ definition }) => refKey(definition.ref))
  );
  for (const { definition } of resolved) {
    for (const required of definition.requires) {
      if (!selectedKeys.has(refKey(required))) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          `Facet ${refKey(definition.ref)} requires ${refKey(required)}.`
        );
      }
    }
    for (const conflict of definition.conflicts) {
      if (selectedKeys.has(refKey(conflict))) {
        throw new ScaffoldError(
          "SCAFFOLD_INPUT_INVALID",
          `Facet ${refKey(definition.ref)} conflicts with ${refKey(conflict)}.`
        );
      }
    }
  }
  return Object.freeze(resolved);
}

function assertContributionPath(
  target: ScaffoldRenderingTarget,
  contribution: ScaffoldFileContribution
): void {
  if (
    target.path.includes("\\") ||
    target.path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      `Target path must be normalized: ${target.path}.`
    );
  }
  const targetPrefix = `${target.path}/`;
  if (
    !contribution.path.startsWith(targetPrefix) ||
    contribution.path.includes("\\") ||
    contribution.path.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      `Definition output escapes target ${target.id}: ${contribution.path}.`
    );
  }
}

function operationsFromContributions(
  target: ScaffoldRenderingTarget,
  contributions: readonly ScaffoldFileContribution[]
): readonly ScaffoldRenderingOperation[] {
  if (
    contributions.length === 0 ||
    contributions.length > MAX_SCAFFOLD_OPERATIONS
  ) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "A scaffolding Plan must contain a bounded non-empty operation set."
    );
  }
  assertUnique(contributions, ({ path }) => path, "output path");
  let totalBytes = 0;
  const operations = contributions.map((contribution) => {
    assertContributionPath(target, contribution);
    const bytes = Buffer.from(contribution.content, "utf8");
    if (bytes.byteLength > MAX_SCAFFOLD_FILE_BYTES) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Generated file exceeds ${MAX_SCAFFOLD_FILE_BYTES} bytes: ${contribution.path}.`
      );
    }
    totalBytes += bytes.byteLength;
    const readableId = `materialize/${contribution.path}`;
    return Object.freeze({
      id:
        readableId.length <= MAX_SCAFFOLD_ID_LENGTH
          ? readableId
          : `materialize/${sha256Text(contribution.path).slice("sha256:".length)}`,
      kind: "materialize-file" as const,
      path: contribution.path,
      precondition: Object.freeze({ state: "absent" as const }),
      after: Object.freeze({
        digest: sha256Bytes(bytes),
        size: bytes.byteLength,
        mode: "0644" as const,
        mediaType: contribution.mediaType,
        contentBase64: bytes.toString("base64")
      }),
      causes: Object.freeze([...contribution.causes].toSorted(compareStrings))
    });
  });
  if (totalBytes > MAX_SCAFFOLD_TOTAL_BYTES) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      `Generated output exceeds ${MAX_SCAFFOLD_TOTAL_BYTES} bytes.`
    );
  }
  return Object.freeze(
    operations.toSorted((left, right) => compareStrings(left.path, right.path))
  );
}

function definitionEvidence(
  registry: ScaffoldDefinitionRegistry,
  definitions: readonly ScaffoldDefinition[]
): readonly ScaffoldRenderingDefinitionEvidence[] {
  return Object.freeze(
    definitions
      .map((definition) =>
        Object.freeze({
          kind: definition.kind,
          ref: definition.ref,
          contractDigest: registry.digest(definition)
        })
      )
      .toSorted((left, right) => {
        const kindOrder = compareStrings(left.kind, right.kind);
        return kindOrder === 0
          ? compareStrings(refKey(left.ref), refKey(right.ref))
          : kindOrder;
      })
  );
}

export function resolveScaffoldRenderingSelection<
  TComposition extends ScaffoldRenderingComposition,
  TTarget extends ScaffoldRenderingTarget
>(input: {
  readonly compositions: readonly TComposition[];
  readonly targets: readonly TTarget[];
  readonly authorityReadPaths: readonly string[];
  readonly intent: ScaffoldRenderingIntent;
}): {
  readonly composition: TComposition;
  readonly target: TTarget;
} {
  assertUnique(input.compositions, ({ id }) => id, "Composition ID");
  assertUnique(input.targets, ({ id }) => id, "target ID");
  assertUnique(input.targets, ({ path }) => path, "target path");
  assertUnique(
    input.targets,
    ({ path }) => path.toLowerCase(),
    "case-folded target path"
  );
  assertUnique(
    input.targets,
    ({ packageName }) => packageName,
    "target package name"
  );
  assertUnique(input.authorityReadPaths, (path) => path, "authority read path");
  const composition = findExactlyOne(
    input.compositions,
    ({ id }) => id === input.intent.compositionId,
    `Composition must exist exactly once: ${input.intent.compositionId}.`
  );
  const target = findExactlyOne(
    input.targets,
    ({ id }) => id === input.intent.targetRef,
    `Scaffold target must exist exactly once: ${input.intent.targetRef}.`
  );
  assertUnique(composition.targetRoles, (role) => role, "target role");
  if (!composition.targetRoles.includes(target.role)) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Target role ${target.role} is not admitted by composition ${composition.id}.`
    );
  }
  return { composition, target };
}

export interface ScaffoldRenderingInput {
  readonly foundationVersion: string;
  readonly intent: ScaffoldRenderingIntent;
  readonly composition: ScaffoldRenderingComposition;
  readonly target: ScaffoldRenderingTarget;
  readonly verifiedOwnerDocumentId?: string;
}

export interface ScaffoldRenderingResult {
  readonly compiler: ScaffoldRenderingCompiler;
  readonly intent: ScaffoldRenderingIntent;
  readonly intentDigest: Sha256Digest;
  readonly composition: ScaffoldRenderingCompositionSelection;
  readonly definitions: readonly ScaffoldRenderingDefinitionEvidence[];
  readonly resolved: ScaffoldRenderingResolution;
  readonly operations: readonly ScaffoldRenderingOperation[];
  readonly diagnostics: readonly ScaffoldRenderingDiagnostic[];
}

function assertFacetCompatibility(
  facets: readonly { readonly definition: ScaffoldFacetDefinition }[],
  recipeId: string
): void {
  for (const { definition } of facets) {
    if (!definition.allowedRecipeIds.includes(recipeId)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Facet ${refKey(definition.ref)} is incompatible with Recipe ${recipeId}.`
      );
    }
  }
}

export function compileScaffoldRendering(
  input: ScaffoldRenderingInput,
  registry: ScaffoldDefinitionRegistry
): ScaffoldRenderingResult {
  const { composition, target } = input;
  assertUnique(composition.targetRoles, (role) => role, "target role");
  if (!composition.targetRoles.includes(target.role)) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Target role ${target.role} is not admitted by composition ${composition.id}.`
    );
  }
  const profile = registry.resolve(
    composition.scaffoldProfile.ref,
    "scaffold-profile"
  );
  const recipe = registry.resolve(composition.recipe.ref, "recipe");
  const profileParameters = composition.scaffoldProfile.parameters ?? {};
  const recipeParameters = mergeRecipeParameters(
    composition,
    input.intent.recipeParameters ?? {}
  );
  registry.validateParameters(profile, profileParameters);
  registry.validateParameters(recipe, recipeParameters);
  if (!profile.allowedRecipeIds.includes(recipe.ref.id)) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Recipe ${refKey(recipe.ref)} is incompatible with the selected Profile or target role.`
    );
  }

  const facets = selectFacets(registry, composition, input.intent.facets);
  assertFacetCompatibility(facets, recipe.ref.id);

  const baseContext: ScaffoldDefinitionContext = Object.freeze({
    target,
    ...(input.verifiedOwnerDocumentId === undefined
      ? {}
      : { verifiedOwnerDocumentId: input.verifiedOwnerDocumentId }),
    profileParameters,
    recipeParameters,
    facetParameters: Object.freeze({})
  });
  registry.assertRecipeRequirements(recipe, profile.ref.id, baseContext);
  const policyConfigurations = collectPolicies([
    profile.requiredPolicies,
    recipe.requiredPolicies,
    ...facets.map(({ definition }) => definition.requiredPolicies),
    composition.policies
  ]);
  const policies = policyConfigurations.map((configured) => {
    const definition = registry.resolve(configured.ref, "policy");
    const parameters = configured.parameters ?? {};
    registry.validateParameters(definition, parameters);
    definition.evaluate(baseContext, parameters);
    return definition;
  });
  const contributions: ScaffoldFileContribution[] = [
    ...recipe.compile(baseContext)
  ];
  for (const facet of facets) {
    contributions.push(
      ...facet.definition.compile(
        Object.freeze({
          ...baseContext,
          facetParameters: facet.parameters
        })
      )
    );
  }
  const operations = operationsFromContributions(target, contributions);
  const definitions = definitionEvidence(registry, [
    profile,
    recipe,
    ...facets.map(({ definition }) => definition),
    ...policies
  ]);
  const normalizedIntent = JSON.parse(
    canonicalJson({
      schemaVersion: 1,
      compositionId: input.intent.compositionId,
      targetRef: input.intent.targetRef,
      ...(input.intent.recipeParameters === undefined
        ? {}
        : { recipeParameters: input.intent.recipeParameters }),
      ...(input.intent.facets === undefined
        ? {}
        : {
            facets: [...input.intent.facets].toSorted((left, right) =>
              compareStrings(refKey(left.ref), refKey(right.ref))
            )
          })
    } as unknown as JsonValue)
  ) as ScaffoldRenderingIntent;
  return Object.freeze({
    compiler: Object.freeze({
      id: "@agent-teams/engineering-foundation" as const,
      version: input.foundationVersion
    }),
    intent: normalizedIntent,
    intentDigest: sha256Json(normalizedIntent as unknown as JsonValue),
    composition: Object.freeze({
      id: composition.id,
      scaffoldProfile: profile.ref,
      recipe: recipe.ref,
      facets: Object.freeze(facets.map(({ definition }) => definition.ref)),
      policies: Object.freeze(policies.map(({ ref }) => ref))
    }),
    definitions,
    resolved: Object.freeze({
      profileParameters,
      recipeParameters,
      facets: Object.freeze(
        facets.map(({ definition, parameters }) =>
          Object.freeze({ ref: definition.ref, parameters })
        )
      ),
      policies: Object.freeze(
        policyConfigurations.map((configured) =>
          Object.freeze({
            ref: configured.ref,
            parameters: configured.parameters ?? {},
            outcome: "passed" as const
          })
        )
      )
    }),
    operations,
    diagnostics: Object.freeze([])
  });
}
