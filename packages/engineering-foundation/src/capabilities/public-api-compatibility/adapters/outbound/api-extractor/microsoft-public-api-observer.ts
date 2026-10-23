import { assertPinnedAuditSdk, auditToolchainIdentity } from "./load-pinned-audit-sdk.js";

import { withNativePublicApiProject } from "./native-public-api-engine.js";

import { stagePublicApiAudit, type AuditInputStage } from "../filesystem/stage-public-api-audit.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { PublicApiObserver } from "../../../application/ports/public-api-observer.js";
import {
  PUBLIC_API_AUDIT_PROFILE,
  type AuditObservation,
  type AuditReference,
} from "../../../application/model/public-api-observation.js";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";
import {
  auditDigest,
  auditInputPath,
  remapAuditStagePath,
  AUDIT_MAX_FILES,
} from "../filesystem/public-api-audit-inputs.js";

import type { ObservationContext } from "./native-audit-context.js";
import { prepareNativeFiles, compilerEnvironment } from "./native-audit-configuration.js";
import { collectMetadataPresence, restoreStagePaths } from "./native-audit-evidence.js";
import {
  createNativeAuditObservationState,
  observeNativeAuditEntrypoint,
} from "./native-audit-session.js";

async function observeEntrypoint(context: ObservationContext): Promise<AuditObservation> {
  const { input, allowed, pkg, entry } = context;
  assertNotCancelled(input.signal);
  const outputRoot = await realpath(await mkdtemp(join(tmpdir(), "foundation-public-api-audit-")));
  const stageRoot = join(outputRoot, "evidence");
  let effectiveContext = context;
  let stage: AuditInputStage | undefined;
  const state = createNativeAuditObservationState();
  const unsupported = state.unsupported;
  const configFiles = new Map<string, string>();
  let revalidated = false;
  try {
    const metadataPresence = collectMetadataPresence(allowed, configFiles);
    stage = await stagePublicApiAudit(input.consumerRoot, allowed, stageRoot);
    const metadataDigests = [...configFiles];
    configFiles.clear();
    for (const [path, digest] of metadataDigests) {
      configFiles.set(join(stage.root, relative(input.consumerRoot, path)), digest);
    }
    effectiveContext = {
      ...context,
      input: { ...input, consumerRoot: stage.root },
      allowed: stage.files,
      subjectRoot: join(stage.root, relative(input.consumerRoot, context.subjectRoot)),
    };
    const prepared = prepareNativeFiles(effectiveContext, configFiles);
    await withNativePublicApiProject(
      {
        cwd: stage.root,
        configPath: prepared.configPath,
        files: prepared.files,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      (native) =>
        observeNativeAuditEntrypoint(
          native,
          effectiveContext,
          state,
          configFiles,
          metadataPresence,
        ),
    );
    await stage.revalidate();
    revalidated = true;
  } catch (error) {
    unsupported.push(String(error));
  } finally {
    // Each owned-resource cleanup is independent; evidence survives either failure.
    try {
      await stage?.release();
    } catch (error) {
      unsupported.push(
        `owned-resource-cleanup: permission-restore: ${outputRoot}: ${String(error)}`,
      );
    }
    try {
      await rm(outputRoot, { recursive: true, force: true });
    } catch (error) {
      unsupported.push(`owned-resource-cleanup: removal: ${outputRoot}: ${String(error)}`);
    }
  }
  assertNotCancelled(input.signal);
  const fileIdentity = (path: string, digest: string) => ({
    path: relative(input.consumerRoot, remapAuditStagePath(path, stageRoot, input.consumerRoot))
      .split(sep)
      .join("/"),
    digest,
  });
  return {
    subject: input.subject,
    packageName: pkg.packageName,
    packageVersion: pkg.packageVersion,
    exportPath: entry?.exportPath ?? null,
    modelExpected: entry !== undefined,
    toolchain: auditToolchainIdentity(),
    normalizationProfile: PUBLIC_API_AUDIT_PROFILE,
    compilerEnvironment: compilerEnvironment(state.compilerOptions, effectiveContext),
    compilerOptions: restoreStagePaths(state.compilerOptions, stageRoot, input.consumerRoot),
    configurationDependencies: [...configFiles].map(([path, digest]) => fileIdentity(path, digest)),
    sourceFiles: state.sources.map((source) =>
      fileIdentity(source.fileName, auditDigest(source.text)),
    ),
    externalDeclarations: state.sources
      .filter((source) => source.library)
      .map((source) => ({ path: basename(source.fileName), digest: auditDigest(source.text) })),
    ...(state.storedSurface === undefined ? {} : { storedSurface: state.storedSurface }),
    diagnostics: restoreStagePaths(state.diagnostics, stageRoot, input.consumerRoot),
    compilerDiagnosticsCollected: state.collected,
    invocation: state.invocation,
    modelPresent: state.modelPresent,
    ...(state.modelDigest === undefined ? {} : { modelDigest: state.modelDigest }),
    items: state.items,
    inputBytesRevalidated: revalidated,
    unsupported,
  };
}

function resolveSubjectReferences(
  observations: readonly AuditObservation[],
  bindings: ReadonlyMap<AuditObservation, ReadonlyMap<AuditReference, string>>,
): readonly AuditObservation[] {
  return observations.map((observation) => ({
    ...observation,
    items: observation.items.map((item) => ({
      ...item,
      references: item.references.map((reference): AuditReference => {
        if (reference.resolution !== "unresolved") {
          return reference;
        }
        const candidates = observations
          .filter(
            (candidate) =>
              candidate.packageName !== observation.packageName &&
              bindings.get(observation)?.get(reference) ===
                JSON.stringify([candidate.packageName, candidate.exportPath]),
          )
          .flatMap((candidate) => candidate.items)
          .filter(
            (candidate) =>
              candidate.identity.canonicalReference === reference.canonicalReference &&
              candidate.public,
          );
        return candidates.length === 1
          ? { ...reference, resolution: "same-subject-dependency", target: candidates[0]!.identity }
          : candidates.length > 1
            ? { ...reference, resolution: "ambiguous" }
            : reference;
      }),
    })),
  }));
}

export class MicrosoftPublicApiObserver implements PublicApiObserver {
  async observe(
    request: Parameters<PublicApiObserver["observe"]>[0],
  ): Promise<readonly AuditObservation[]> {
    assertNotCancelled(request.signal);
    assertPinnedAuditSdk();
    // Match auditInputPath's native realpath: the JS sync variant can retain Windows 8.3 aliases.
    const input = { ...request, consumerRoot: await realpath(request.consumerRoot) };
    const expectedModels = input.declarations.packages.reduce(
      (total, pkg) => total + Math.max(1, pkg.entrypoints.length),
      0,
    );
    if (expectedModels > 64 || input.declarations.files.length > AUDIT_MAX_FILES) {
      throw new Error("Audit subject exceeds the 64-model or input-file budget.");
    }
    const allowed = new Map<string, string>();
    for (const file of input.declarations.files) {
      allowed.set(await auditInputPath(input.consumerRoot, file.path), file.digest);
    }
    let subjectRoot = dirname([...allowed.keys()][0] ?? resolve(input.consumerRoot));
    for (const path of allowed.keys()) {
      while (path !== subjectRoot && !path.startsWith(`${subjectRoot}${sep}`)) {
        const parent = dirname(subjectRoot);
        if (parent === subjectRoot) {
          break;
        }
        subjectRoot = parent;
      }
    }
    const observations: AuditObservation[] = [];
    const bindings = new Map<AuditObservation, ReadonlyMap<AuditReference, string>>();
    let retainedBytes = 0;
    for (const pkg of input.declarations.packages.toSorted((a, b) =>
      a.packageName.localeCompare(b.packageName),
    )) {
      const entries =
        pkg.entrypoints.length === 0
          ? [undefined]
          : pkg.entrypoints.toSorted((a, b) => a.exportPath.localeCompare(b.exportPath));
      for (const entry of entries) {
        const dependencyBindings = new Map<AuditReference, string>();
        const observation = await observeEntrypoint({
          input,
          allowed,
          subjectRoot,
          pkg,
          entry,
          dependencyBindings,
        });
        bindings.set(observation, dependencyBindings);
        retainedBytes += Buffer.byteLength(JSON.stringify(observation));
        if (retainedBytes > 64 * 1024 * 1024) {
          observations.push({
            ...observation,
            unsupported: [...observation.unsupported, "subject-observation-byte-budget-exhausted"],
          });
          return resolveSubjectReferences(observations, bindings);
        }
        observations.push(observation);
      }
    }
    return resolveSubjectReferences(observations, bindings);
  }
}
