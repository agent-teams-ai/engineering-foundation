import type {
  JsonValue,
  ScaffoldCompilationInput,
  ScaffoldPlanV1
} from "../contract/types.js";
import { sha256Json } from "./canonical-json.js";
import {
  compileScaffoldRendering,
  resolveScaffoldRenderingSelection
} from "./compiler.js";
import type { ScaffoldDefinitionRegistry } from "./definition-registry.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compileScaffoldPlan(
  input: ScaffoldCompilationInput,
  registry: ScaffoldDefinitionRegistry
): ScaffoldPlanV1 {
  const { composition, target } = resolveScaffoldRenderingSelection({
    compositions: input.config.compositions,
    targets: input.catalog.packages,
    authorityReadPaths: input.authorityReadSet.map(({ path }) => path),
    intent: input.intent
  });
  const rendering = compileScaffoldRendering(
    {
      foundationVersion: input.foundationVersion,
      intent: input.intent,
      composition,
      target
    },
    registry
  );
  const authoritySnapshotDigest = sha256Json({
    configPath: input.configPath,
    projectId: input.config.projectId,
    composition,
    target,
    readSet: input.authorityReadSet
  } as unknown as JsonValue);
  const planBody = {
    schemaVersion: 1 as const,
    protocolVersion: 1 as const,
    ...rendering,
    projectId: input.config.projectId,
    authority: Object.freeze({
      configPath: input.configPath,
      targetCatalogPath: input.config.targetCatalogPath
    }),
    authoritySnapshotDigest,
    target,
    readSet: Object.freeze(
      [...input.authorityReadSet].toSorted((left, right) =>
        compareStrings(left.path, right.path)
      )
    ),
    requiredAdapterCapabilities: ["materialize-file/v1"] as const
  };
  const planDigest = sha256Json(planBody as unknown as JsonValue);
  return Object.freeze({ ...planBody, planDigest });
}
