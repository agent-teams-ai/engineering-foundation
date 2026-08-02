import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ScaffoldCompilationInput,
  ScaffoldIntentV1,
  ScaffoldPlanV1,
  ScaffoldReadAssertionV1,
  ScaffoldingConfigV1,
  ScaffoldTargetCatalogV1
} from "../../contract/types.js";
import { sha256Bytes } from "../../kernel/canonical-json.js";
import { assertScaffoldPlanDigest } from "../../kernel/plan-validation.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { pathTraversesSymbolicLink } from "../../../filesystem-path-safety.js";
import { assertSchema } from "../../../schema-catalog.js";
import {
  assertRepositoryRelativePath,
  parseStrictYamlSource
} from "../../../strict-yaml.js";

const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_SCAFFOLD_PLAN_BYTES = 32 * 1024 * 1024;

interface LoadedRepositoryFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly source: string;
}

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

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

async function readContainedRepositoryFile(
  consumerRoot: string,
  repositoryPath: string,
  phase: string,
  maxBytes = MAX_INPUT_BYTES
): Promise<LoadedRepositoryFile> {
  try {
    assertRepositoryRelativePath(repositoryPath, phase);
    const canonicalRoot = await realpath(consumerRoot);
    const candidate = resolve(canonicalRoot, repositoryPath);
    if (await pathTraversesSymbolicLink(canonicalRoot, candidate)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input cannot traverse a symbolic link: ${repositoryPath}.`
      );
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isContained(canonicalRoot, canonicalCandidate)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input escapes the consumer repository: ${repositoryPath}.`
      );
    }
    const metadata = await lstat(canonicalCandidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > maxBytes
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input must be a regular file no larger than ${maxBytes} bytes: ${repositoryPath}.`
      );
    }
    const bytes = await readFile(canonicalCandidate);
    return {
      path: repositoryPath,
      bytes,
      source: bytes.toString("utf8")
    };
  } catch (error) {
    if (error instanceof ScaffoldError) {
      throw error;
    }
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Cannot read scaffolding input: ${repositoryPath}.`,
      [],
      { cause: error }
    );
  }
}

function assertion(file: LoadedRepositoryFile): ScaffoldReadAssertionV1 {
  const canonicalBytes = Buffer.from(
    file.source.replace(/\r\n?/gu, "\n"),
    "utf8"
  );
  return Object.freeze({
    path: file.path,
    state: "file" as const,
    digest: sha256Bytes(canonicalBytes),
    size: canonicalBytes.byteLength
  });
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
  await assertSchema("scaffold-plan/v1", value, "scaffold-plan");
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
