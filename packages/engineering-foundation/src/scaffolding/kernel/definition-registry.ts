import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type {
  ConfiguredDefinition,
  DefinitionRef,
  JsonObject,
  JsonValue,
  ScaffoldFileContribution,
  ScaffoldRenderingTarget,
  Sha256Digest
} from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import { sha256Json } from "./canonical-json.js";

export type ScaffoldDefinitionKind =
  | "facet"
  | "policy"
  | "recipe"
  | "scaffold-profile";

export interface ScaffoldDefinitionContext {
  readonly target: ScaffoldRenderingTarget;
  readonly verifiedOwnerDocumentId?: string;
  readonly profileParameters: JsonObject;
  readonly recipeParameters: JsonObject;
  readonly facetParameters: JsonObject;
}

interface BaseDefinition {
  readonly kind: ScaffoldDefinitionKind;
  readonly ref: DefinitionRef;
  readonly descriptor: JsonValue;
  readonly parameterSchema: object;
}

interface ScaffoldProfileDefinition extends BaseDefinition {
  readonly kind: "scaffold-profile";
  readonly allowedRecipeIds: readonly string[];
  readonly requiredPolicies: readonly ConfiguredDefinition[];
}

interface ScaffoldRecipeDefinition extends BaseDefinition {
  readonly kind: "recipe";
  readonly allowedProfileIds: readonly string[];
  readonly allowedTargetRoles: readonly string[] | "composition";
  readonly requiredAuthority?: "owner-document/v1";
  readonly requiredPolicies: readonly ConfiguredDefinition[];
  compile(context: ScaffoldDefinitionContext): readonly ScaffoldFileContribution[];
}

export interface ScaffoldFacetDefinition extends BaseDefinition {
  readonly kind: "facet";
  readonly allowedRecipeIds: readonly string[];
  readonly requires: readonly DefinitionRef[];
  readonly conflicts: readonly DefinitionRef[];
  readonly requiredPolicies: readonly ConfiguredDefinition[];
  compile(context: ScaffoldDefinitionContext): readonly ScaffoldFileContribution[];
}

interface ScaffoldPolicyDefinition extends BaseDefinition {
  readonly kind: "policy";
  evaluate(context: ScaffoldDefinitionContext, parameters: JsonObject): void;
}

export type ScaffoldDefinition =
  | ScaffoldFacetDefinition
  | ScaffoldPolicyDefinition
  | ScaffoldProfileDefinition
  | ScaffoldRecipeDefinition;

function definitionKey(ref: DefinitionRef): string {
  return `${ref.id}@${ref.contractVersion}`;
}

function compareDefinitionRefs(left: DefinitionRef, right: DefinitionRef): number {
  const leftKey = definitionKey(left);
  const rightKey = definitionKey(right);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

function validationMessage(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ")
    .slice(0, 1000);
}

export class ScaffoldDefinitionRegistry {
  readonly #definitions: ReadonlyMap<string, ScaffoldDefinition>;
  readonly #validators = new Map<string, ValidateFunction>();

  constructor(definitions: readonly ScaffoldDefinition[]) {
    const entries = new Map<string, ScaffoldDefinition>();
    for (const definition of definitions) {
      const key = definitionKey(definition.ref);
      if (entries.has(key)) {
        throw new Error(`Duplicate scaffolding definition: ${key}.`);
      }
      entries.set(key, Object.freeze(definition));
    }
    this.#definitions = entries;
  }

  resolve<TKind extends ScaffoldDefinitionKind>(
    ref: DefinitionRef,
    expectedKind: TKind
  ): Extract<ScaffoldDefinition, { readonly kind: TKind }> {
    const definition = this.#definitions.get(definitionKey(ref));
    if (definition === undefined || definition.kind !== expectedKind) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Unknown ${expectedKind} definition: ${definitionKey(ref)}.`
      );
    }
    return definition as Extract<ScaffoldDefinition, { readonly kind: TKind }>;
  }

  validateParameters(definition: ScaffoldDefinition, parameters: JsonObject): void {
    const key = definitionKey(definition.ref);
    let validate = this.#validators.get(key);
    if (validate === undefined) {
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      validate = ajv.compile(definition.parameterSchema);
      this.#validators.set(key, validate);
    }
    if (!validate(parameters)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Invalid parameters for ${key}: ${validationMessage(validate)}`
      );
    }
  }

  assertRecipeRequirements(
    definition: ScaffoldRecipeDefinition,
    profileId: string,
    context: ScaffoldDefinitionContext
  ): void {
    if (
      !definition.allowedProfileIds.includes(profileId) ||
      (definition.allowedTargetRoles !== "composition" &&
        !definition.allowedTargetRoles.includes(context.target.role))
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Recipe ${definitionKey(definition.ref)} is incompatible with the selected Profile or target role.`
      );
    }
    if (
      definition.requiredAuthority === "owner-document/v1" &&
      context.verifiedOwnerDocumentId === undefined
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Recipe ${definitionKey(definition.ref)} requires verified owner-document authority.`
      );
    }
  }

  digest(definition: ScaffoldDefinition): Sha256Digest {
    const common = {
      kind: definition.kind,
      ref: definition.ref,
      descriptor: definition.descriptor,
      parameterSchema: definition.parameterSchema
    };
    switch (definition.kind) {
      case "facet":
        return sha256Json({
          ...common,
          allowedRecipeIds: definition.allowedRecipeIds.toSorted(),
          requires: definition.requires.toSorted(compareDefinitionRefs),
          conflicts: definition.conflicts.toSorted(compareDefinitionRefs),
          requiredPolicies: definition.requiredPolicies.toSorted((left, right) =>
            compareDefinitionRefs(left.ref, right.ref)
          )
        } as unknown as JsonValue);
      case "policy":
        return sha256Json(common as unknown as JsonValue);
      case "recipe":
        return sha256Json({
          ...common,
          allowedProfileIds: definition.allowedProfileIds.toSorted(),
          allowedTargetRoles:
            definition.allowedTargetRoles === "composition"
              ? "composition"
              : definition.allowedTargetRoles.toSorted(),
          ...(definition.requiredAuthority === undefined
            ? {}
            : { requiredAuthority: definition.requiredAuthority }),
          requiredPolicies: definition.requiredPolicies.toSorted((left, right) =>
            compareDefinitionRefs(left.ref, right.ref)
          )
        } as unknown as JsonValue);
      case "scaffold-profile":
        return sha256Json({
          ...common,
          allowedRecipeIds: definition.allowedRecipeIds.toSorted(),
          requiredPolicies: definition.requiredPolicies.toSorted((left, right) =>
            compareDefinitionRefs(left.ref, right.ref)
          )
        } as unknown as JsonValue);
    }
  }
}
