import { posix } from "node:path";

import type {
  JsonObject,
  ScaffoldFileContribution
} from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import type {
  ScaffoldDefinition,
  ScaffoldDefinitionContext
} from "../kernel/definition-registry.js";

const EMPTY_PARAMETERS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false
});

const PROFILE_PARAMETERS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["tsconfigBase"],
  properties: {
    tsconfigBase: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      pattern: "^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9._@/-]+$"
    }
  }
});

const RECIPE_PARAMETERS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["featureId"],
  properties: {
    featureId: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$"
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 240
    }
  }
});

const TARGET_ROLE_POLICY_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["allowedRoles"],
  properties: {
    allowedRoles: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        pattern: "^[a-z0-9][a-z0-9._/-]*$"
      }
    }
  }
});

function requiredString(parameters: JsonObject, key: string): string {
  const value = parameters[key];
  if (typeof value !== "string") {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Missing validated string parameter: ${key}.`
    );
  }
  return value;
}

function repositoryFile(
  context: ScaffoldDefinitionContext,
  relativePath: string,
  content: string,
  causes: readonly string[],
  mediaType = "text/plain"
): ScaffoldFileContribution {
  return Object.freeze({
    path: posix.join(context.target.path, relativePath),
    mediaType,
    content,
    causes
  });
}

function recipeFiles(
  context: ScaffoldDefinitionContext
): readonly ScaffoldFileContribution[] {
  const featureId = requiredString(context.recipeParameters, "featureId");
  const description = context.recipeParameters.description;
  const tsconfigBase = requiredString(
    context.profileParameters,
    "tsconfigBase"
  );
  const extendsPath = posix.relative(context.target.path, tsconfigBase);
  const packageManifest = {
    name: context.target.packageName,
    version: "0.0.0",
    private: true,
    ...(typeof description === "string" ? { description } : {}),
    type: "module",
    exports: {
      ".": "./src/index.ts"
    },
    scripts: {
      typecheck: "tsc --project tsconfig.json --noEmit --pretty false"
    }
  };
  const tsconfig = {
    extends: extendsPath.startsWith(".") ? extendsPath : `./${extendsPath}`,
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: true,
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
      tsBuildInfoFile: "dist/.tsbuildinfo"
    },
    include: ["src/**/*.ts"]
  };
  const identitySource = `export const fixtureIdentity = Object.freeze({\n  featureId: ${JSON.stringify(featureId)},\n  packageName: ${JSON.stringify(context.target.packageName)}\n});\n`;
  const entrypointSource = `export { fixtureIdentity } from "./features/${featureId}/index.js";\n`;

  return Object.freeze([
    repositoryFile(
      context,
      "package.json",
      `${JSON.stringify(packageManifest, null, 2)}\n`,
      ["foundation.conformance-fixture-package"],
      "application/json"
    ),
    repositoryFile(
      context,
      "tsconfig.json",
      `${JSON.stringify(tsconfig, null, 2)}\n`,
      ["foundation.conformance-fixture-package"],
      "application/json"
    ),
    repositoryFile(
      context,
      `src/features/${featureId}/index.ts`,
      identitySource,
      ["foundation.conformance-fixture-package"]
    ),
    repositoryFile(
      context,
      "src/index.ts",
      entrypointSource,
      ["foundation.conformance-fixture-package"]
    )
  ]);
}

function typecheckFixtureFiles(
  context: ScaffoldDefinitionContext
): readonly ScaffoldFileContribution[] {
  const featureId = requiredString(context.recipeParameters, "featureId");
  const source = `import { fixtureIdentity } from "./index.js";\n\nexport const fixtureFeatureId: string = fixtureIdentity.featureId;\nexport const expectedFixtureFeatureId = ${JSON.stringify(featureId)};\n`;
  return Object.freeze([
    repositoryFile(
      context,
      `src/features/${featureId}/index.contract.ts`,
      source,
      ["foundation.typecheck-fixture"]
    )
  ]);
}

function fixtureReadmeFiles(
  context: ScaffoldDefinitionContext
): readonly ScaffoldFileContribution[] {
  const featureId = requiredString(context.recipeParameters, "featureId");
  const source = `# ${context.target.packageName}\n\nDeterministic conformance fixture for \`${featureId}\`.\n`;
  return Object.freeze([
    repositoryFile(
      context,
      "README.md",
      source,
      ["foundation.fixture-readme"],
      "text/markdown"
    )
  ]);
}

export const CONFORMANCE_FIXTURE_DEFINITIONS: readonly ScaffoldDefinition[] =
  Object.freeze([
    {
      kind: "scaffold-profile",
      ref: {
        id: "foundation.node-typescript-fixture",
        contractVersion: 1
      },
      descriptor: {
        kind: "scaffold-profile",
        id: "foundation.node-typescript-fixture",
        contractVersion: 1,
        semantics: "node-typescript-testing-only"
      },
      parameterSchema: PROFILE_PARAMETERS_SCHEMA,
      allowedRecipeIds: ["foundation.conformance-fixture-package"],
      requiredPolicies: [
        {
          ref: { id: "foundation.target-role", contractVersion: 1 },
          parameters: { allowedRoles: ["testing"] }
        }
      ]
    },
    {
      kind: "recipe",
      ref: {
        id: "foundation.conformance-fixture-package",
        contractVersion: 1
      },
      descriptor: {
        kind: "recipe",
        id: "foundation.conformance-fixture-package",
        contractVersion: 1,
        semantics: "materialize-a-non-product-conformance-package"
      },
      parameterSchema: RECIPE_PARAMETERS_SCHEMA,
      allowedProfileIds: ["foundation.node-typescript-fixture"],
      allowedTargetRoles: ["testing"],
      requiredPolicies: [],
      compile: recipeFiles
    },
    {
      kind: "facet",
      ref: { id: "foundation.typecheck-fixture", contractVersion: 1 },
      descriptor: {
        kind: "facet",
        id: "foundation.typecheck-fixture",
        contractVersion: 1,
        semantics: "compile-time-contract-for-conformance-fixture"
      },
      parameterSchema: EMPTY_PARAMETERS_SCHEMA,
      allowedRecipeIds: ["foundation.conformance-fixture-package"],
      requires: [],
      conflicts: [],
      requiredPolicies: [],
      compile: typecheckFixtureFiles
    },
    {
      kind: "facet",
      ref: { id: "foundation.fixture-readme", contractVersion: 1 },
      descriptor: {
        kind: "facet",
        id: "foundation.fixture-readme",
        contractVersion: 1,
        semantics: "readme-for-conformance-fixture"
      },
      parameterSchema: EMPTY_PARAMETERS_SCHEMA,
      allowedRecipeIds: ["foundation.conformance-fixture-package"],
      requires: [],
      conflicts: [],
      requiredPolicies: [],
      compile: fixtureReadmeFiles
    },
    {
      kind: "policy",
      ref: { id: "foundation.target-role", contractVersion: 1 },
      descriptor: {
        kind: "policy",
        id: "foundation.target-role",
        contractVersion: 1,
        semantics: "target-role-must-be-explicitly-allowed"
      },
      parameterSchema: TARGET_ROLE_POLICY_SCHEMA,
      evaluate(context, parameters) {
        const allowedRoles = parameters.allowedRoles;
        if (
          !Array.isArray(allowedRoles) ||
          !allowedRoles.includes(context.target.role)
        ) {
          throw new ScaffoldError(
            "SCAFFOLD_INPUT_INVALID",
            `Target role ${context.target.role} is not allowed by the selected composition.`
          );
        }
      }
    }
  ]);
