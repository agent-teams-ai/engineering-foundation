import type {
  ScaffoldCompilationInput,
  ScaffoldIntentV1,
  ScaffoldPlanV1,
  ScaffoldReadAssertionV1,
  ScaffoldingConfigV1,
  ScaffoldTargetCatalogV1
} from "../../contract/types.js";
import { assertScaffoldPlanDigest } from "../../kernel/rendering-plan-validation.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  parseStrictYamlSource
} from "../../../strict-yaml.js";
import {
  assertion,
  readContainedRepositoryFile,
  type LoadedRepositoryFile
} from "./node-repository-file.js";
import { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

export { MAX_SCAFFOLD_PLAN_BYTES } from "./node-scaffold-limits.js";

function hasErrorCode(error: unknown, code: string): boolean {
  const visited = new Set<Error>();
  let candidate = error;
  while (candidate instanceof Error && !visited.has(candidate)) {
    visited.add(candidate);
    if (
      "code" in candidate &&
      (candidate as NodeJS.ErrnoException).code === code
    ) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}


function mapCatalog(value: unknown): ScaffoldTargetCatalogV1 {
  const raw = value as {
    readonly version: 1;
    readonly packages: readonly {
      readonly id: string;
      readonly role: string;
      readonly path: string;
      readonly package_name: string;
      readonly owner_document?: string;
    }[];
  };
  return Object.freeze({
    version: 1,
    packages: Object.freeze(
      raw.packages.map((entry) =>
        Object.freeze({
          id: entry.id,
          role: entry.role,
          path: entry.path,
          packageName: entry.package_name,
          ...(entry.owner_document === undefined
            ? {}
            : { ownerDocument: entry.owner_document })
        })
      )
    )
  });
}

export async function loadScaffoldCompilationInput(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly intentPath: string;
  readonly foundationVersion: string;
}): Promise<ScaffoldCompilationInput> {
  const [configFile, intentFile] = await Promise.all([
    readContainedRepositoryFile(
      options.consumerRoot,
      options.configPath,
      "scaffolding-config"
    ),
    readContainedRepositoryFile(
      options.consumerRoot,
      options.intentPath,
      "scaffold-intent"
    )
  ]);
  const configValue = parseStrictYamlSource(
    configFile.source,
    "scaffolding-config"
  );
  const intentValue = parseStrictYamlSource(intentFile.source, "scaffold-intent");
  return loadScaffoldCompilationInputFromIntentInternal({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath,
    foundationVersion: options.foundationVersion,
    intent: intentValue,
    configFile,
    configValue
  });
}

async function loadScaffoldCompilationInputFromIntentInternal(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly foundationVersion: string;
  readonly intent: unknown;
  readonly configFile?: LoadedRepositoryFile;
  readonly configValue?: unknown;
}): Promise<ScaffoldCompilationInput> {
  const configFile =
    options.configFile ??
    (await readContainedRepositoryFile(
      options.consumerRoot,
      options.configPath,
      "scaffolding-config"
    ));
  const configValue =
    options.configValue ??
    parseStrictYamlSource(configFile.source, "scaffolding-config");
  await Promise.all([
    assertSchema("scaffolding-config/v1", configValue, "scaffolding-config"),
    assertSchema("scaffold-intent/v1", options.intent, "scaffold-intent")
  ]);
  const config = configValue as ScaffoldingConfigV1;
  const catalogFile = await readContainedRepositoryFile(
    options.consumerRoot,
    config.targetCatalogPath,
    "scaffold-target-catalog"
  );
  const catalogValue = parseStrictYamlSource(
    catalogFile.source,
    "scaffold-target-catalog"
  );
  await assertSchema(
    "scaffold-target-catalog/v1",
    catalogValue,
    "scaffold-target-catalog"
  );
  return Object.freeze({
    foundationVersion: options.foundationVersion,
    configPath: options.configPath,
    config,
    intent: options.intent as ScaffoldIntentV1,
    catalog: mapCatalog(catalogValue),
    authorityReadSet: Object.freeze([
      assertion(configFile),
      assertion(catalogFile)
    ])
  });
}

export async function loadScaffoldCompilationInputFromIntent(options: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly foundationVersion: string;
  readonly intent: unknown;
}): Promise<ScaffoldCompilationInput> {
  return loadScaffoldCompilationInputFromIntentInternal(options);
}

/** Reads a released 0.5 Plan for regression evidence only. */
export async function readScaffoldPlanFile(
  consumerRoot: string,
  planPath: string
): Promise<ScaffoldPlanV1> {
  const planFile = await readContainedRepositoryFile(
    consumerRoot,
    planPath,
    "scaffold-plan",
    MAX_SCAFFOLD_PLAN_BYTES
  );
  const value = parseStrictYamlSource(planFile.source, "scaffold-plan");
  await assertSchema("scaffold-plan/v1", value, "rendering-regression-plan");
  const plan = value as ScaffoldPlanV1;
  assertScaffoldPlanDigest(plan);
  return plan;
}

export async function inspectAuthorityReadSet(
  consumerRoot: string,
  readSet: readonly ScaffoldReadAssertionV1[]
): Promise<boolean> {
  for (const expected of readSet) {
    let current: LoadedRepositoryFile;
    try {
      current = await readContainedRepositoryFile(
        consumerRoot,
        expected.path,
        "scaffold-apply-read-set"
      );
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    const observed = assertion(current);
    if (
      observed.size !== expected.size ||
      observed.digest !== expected.digest
    ) {
      return false;
    }
  }
  return true;
}
