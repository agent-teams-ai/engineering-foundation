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
  mediaType = "text/plain"
): ScaffoldFileContribution {
  return Object.freeze({
    path: posix.join(context.target.path, relativePath),
    mediaType,
    content,
    causes: Object.freeze(["foundation.node-typescript-library-boundary"])
  });
}

function rootTsconfigReference(context: ScaffoldDefinitionContext): string {
  const tsconfigBase = requiredString(context.profileParameters, "tsconfigBase");
  const reference = posix.relative(context.target.path, tsconfigBase);
  if (reference === "" || (!reference.startsWith("../") && reference !== "..")) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The Node TypeScript library tsconfig base must be outside the target package."
    );
  }
  return reference;
}

function libraryBoundaryFiles(
  context: ScaffoldDefinitionContext
): readonly ScaffoldFileContribution[] {
  const ownerDocumentId = context.verifiedOwnerDocumentId;
  if (ownerDocumentId === undefined) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "The Node TypeScript library recipe requires a verified owner document ID."
    );
  }
  const packageManifest = {
    name: context.target.packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      build: "tsc --project tsconfig.json --pretty false",
      check:
        "pnpm run clean && pnpm run typecheck && pnpm run build && pnpm run test",
      clean:
        "node -e \"const fs=require('node:fs'); for (const path of ['dist','.cache']) fs.rmSync(path, { recursive: true, force: true })\"",
      prepack: "pnpm run clean && pnpm run build",
      test: "node --test --test-concurrency=1",
      typecheck: "tsc --project tsconfig.json --noEmit --pretty false"
    },
    agentTeamsArchitecture: {
      role: context.target.role,
      ownerDocument: ownerDocumentId
    },
    files: ["dist"],
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      }
    }
  };
  const tsconfig = {
    extends: rootTsconfigReference(context),
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: true,
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
      tsBuildInfoFile: ".cache/tsconfig.tsbuildinfo"
    },
    include: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/**/*.mts",
      "src/**/*.cts"
    ]
  };

  return Object.freeze([
    repositoryFile(
      context,
      "package.json",
      `${JSON.stringify(packageManifest, null, 2)}\n`,
      "application/json"
    ),
    repositoryFile(
      context,
      "tsconfig.json",
      `${JSON.stringify(tsconfig, null, 2)}\n`,
      "application/json"
    ),
    repositoryFile(context, "src/index.ts", "export {};\n")
  ]);
}

export const NODE_TYPESCRIPT_LIBRARY_DEFINITIONS: readonly ScaffoldDefinition[] =
  Object.freeze([
    {
      kind: "scaffold-profile",
      ref: {
        id: "foundation.node-typescript-pnpm-esm",
        contractVersion: 1
      },
      descriptor: {
        kind: "scaffold-profile",
        id: "foundation.node-typescript-pnpm-esm",
        contractVersion: 1,
        semantics: "node-esm-typescript-composite-project"
      },
      parameterSchema: PROFILE_PARAMETERS_SCHEMA,
      allowedRecipeIds: ["foundation.node-typescript-library-boundary"],
      requiredPolicies: []
    },
    {
      kind: "recipe",
      ref: {
        id: "foundation.node-typescript-library-boundary",
        contractVersion: 1
      },
      descriptor: {
        kind: "recipe",
        id: "foundation.node-typescript-library-boundary",
        contractVersion: 1,
        semantics: "materialize-a-private-node-typescript-library-boundary"
      },
      parameterSchema: EMPTY_PARAMETERS_SCHEMA,
      allowedProfileIds: ["foundation.node-typescript-pnpm-esm"],
      allowedTargetRoles: "composition",
      requiredAuthority: "owner-document/v1",
      requiredPolicies: [],
      compile: libraryBoundaryFiles
    }
  ]);
