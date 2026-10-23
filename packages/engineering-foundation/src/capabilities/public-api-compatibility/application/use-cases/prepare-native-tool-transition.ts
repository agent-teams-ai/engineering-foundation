import type { PublicApiCompatibilityPolicy as Policy } from "../model/public-api.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import type { NativeTransitionContent } from "../ports/native-tool-transition.js";
import {
  nativeTransitionError as fail,
  type NativeMigrationObservation,
  type NativeMigrationReview,
} from "../model/native-tool-transition.js";
import { assertNativeMigrationReview } from "../policies/validate-native-tool-transition.js";
import { preflightPublicApiPromotions } from "./preflight-public-api-promotions.js";
import type { promotePublicApiBaselines } from "./promote-public-api-baselines.js";
type PromotionDependencies = Parameters<typeof promotePublicApiBaselines>[1];
type PendingWrite = { description: WriteDescription; write: () => Promise<void> };
type MigrationInput = Parameters<typeof prepareNativeMigrationPromotion>[0];
type WriteDescription = Awaited<ReturnType<PublicApiRepository["describeReleasedBaselineWrite"]>>;
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
export interface NativeMigrationPlan {
  readonly kind: "foundation:public-api-native-migration:version-plan:1";
  readonly writes: readonly WriteDescription[];
  /** A local write operation, called only by the existing version workflow. */
  apply(): Promise<void>;
}

/** Reuse normal typed/artifact promotion policy with native A as the logical
 * released surface. The physical writer observes and caches actual B bytes.
 * Every package and both surfaces validate before the first mutation. */
export async function prepareNativeMigrationPromotion(
  options: {
    readonly consumerRoot: string;
    readonly policy: Policy;
    readonly observation: NativeMigrationObservation;
    readonly review: NativeMigrationReview;
    readonly signal?: AbortSignal;
  },
  dependencies: {
    readonly typed: PromotionDependencies;
    readonly artifacts: PromotionDependencies;
    readonly content: NativeTransitionContent;
  },
): Promise<NativeMigrationPlan> {
  // Readonly types do not prevent a caller from mutating the original carrier
  // while an asynchronous read is pending. Keep one private authoritative view.
  const input = {
    consumerRoot: options.consumerRoot,
    policy: structuredClone(options.policy),
    observation: structuredClone(options.observation),
    review: structuredClone(options.review),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const content = dependencies.content;
  assertNativeMigrationReview(input.observation, input.review, input.policy, content);
  const actualTyped = dependencies.typed.repository;
  const physical = await readPhysicalBaselines(input, actualTyped, content);
  const pending: PendingWrite[] = [];
  const scheduled = new Set<string>();
  const scheduleTyped: PublicApiRepository["writeReleasedBaseline"] = async (
    root,
    p,
    snapshot,
    signal,
    mode = "replace",
  ) => {
    const row = input.observation.packages.find((x) => x.packageName === p.packageName)!;
    if (mode !== "replace" || !content.same(snapshot, row.nativeCandidate)) {
      fail("typed promotion differs from actual candidate observation");
    }
    if (scheduled.has(p.packageName)) {
      fail("duplicate typed promotion");
    }
    scheduled.add(p.packageName);
    if (equalBytes(physical.get(p.packageName)!, content.bytes(snapshot))) {
      return;
    }
    const capturedPolicy = structuredClone(p);
    const capturedSnapshot = structuredClone(snapshot);
    const description = await actualTyped.describeReleasedBaselineWrite(
      root,
      capturedPolicy,
      capturedSnapshot,
      mode,
    );
    if (description.preimageDigest !== content.digest(physical.get(p.packageName)!)) {
      fail("logical A was substituted for physical baseline preimage");
    }
    pending.push({
      description,
      write: () =>
        actualTyped.writeReleasedBaseline(root, capturedPolicy, capturedSnapshot, signal, mode),
    });
  };
  const typedRepository: PublicApiRepository = {
    readReleasedBaseline: async (_root, p) =>
      input.observation.packages.find((x) => x.packageName === p.packageName)!.nativeReleased,
    readReleaseEvidence: actualTyped.readReleaseEvidence.bind(actualTyped),
    describeReleasedBaselineWrite: actualTyped.describeReleasedBaselineWrite.bind(actualTyped),
    writeReleasedBaseline: scheduleTyped,
  };
  const typed: PromotionDependencies = {
    ...dependencies.typed,
    repository: typedRepository,
    extractor: {
      extract: async (...args) => {
        const current = await dependencies.typed.extractor.extract(...args);
        const expected = input.observation.packages.find(
          (x) => x.packageName === args[1].packageName,
        )!.nativeCandidate;
        if (!content.same(current, expected)) {
          fail("candidate changed since native migration observation");
        }
        return current;
      },
    },
  };
  const artifactRepository = dependencies.artifacts.repository;
  const artifacts: PromotionDependencies = {
    ...dependencies.artifacts,
    repository: {
      readReleasedBaseline: artifactRepository.readReleasedBaseline.bind(artifactRepository),
      readReleaseEvidence: artifactRepository.readReleaseEvidence.bind(artifactRepository),
      describeReleasedBaselineWrite:
        artifactRepository.describeReleasedBaselineWrite.bind(artifactRepository),
      writeReleasedBaseline: async (...args) => {
        const capturedPolicy = structuredClone(args[1]);
        const capturedSnapshot = structuredClone(args[2]);
        const description = await artifactRepository.describeReleasedBaselineWrite(
          args[0],
          capturedPolicy,
          capturedSnapshot,
          args[4] ?? "replace",
        );
        pending.push({
          description,
          write: () =>
            artifactRepository.writeReleasedBaseline(
              args[0],
              capturedPolicy,
              capturedSnapshot,
              args[3],
              args[4],
            ),
        });
      },
    },
  };
  await preflightPublicApiPromotions(input, [typed, artifacts]);
  // The normal promoter intentionally skips same-version/no-change packages.
  // This named migration must still replace every remaining legacy typed B.
  for (const p of input.policy.packages) {
    if (!scheduled.has(p.packageName)) {
      const row = input.observation.packages.find((x) => x.packageName === p.packageName)!;
      await scheduleTyped(input.consumerRoot, p, row.nativeCandidate, input.signal, "replace");
    }
  }
  if (new Set(pending.map((x) => x.description.destination)).size !== pending.length) {
    fail("duplicate migration destination");
  }
  const checks = new Map(pending.map((item) => [item.description.destination, item.description]));
  // Exact postimages already present during preparation are still part of the
  // complete migration. They must not drift back to B while other files write.
  for (const p of input.policy.packages) {
    if (!checks.has(p.releasedBaselinePath)) {
      checks.set(p.releasedBaselinePath, {
        destination: p.releasedBaselinePath,
        operation: "replace",
        preimageDigest: content.digest(physical.get(p.packageName)!),
        proposedDigest: content.digest(
          content.bytes(
            input.observation.packages.find((row) => row.packageName === p.packageName)!
              .nativeCandidate,
          ),
        ),
      });
    }
  }
  return createNativeMigrationPlan(input.consumerRoot, checks, pending, content);
}

async function readPhysicalBaselines(
  input: MigrationInput,
  actualTyped: PublicApiRepository,
  content: NativeTransitionContent,
): Promise<Map<string, Uint8Array>> {
  const physical = new Map<string, Uint8Array>();
  for (const p of input.policy.packages) {
    const observed = input.observation.packages.find((x) => x.packageName === p.packageName)!;
    await actualTyped.readReleasedBaseline(
      input.consumerRoot,
      p,
      input.signal,
      "release-promotion",
    );
    const bytes = await content.read(input.consumerRoot, p.releasedBaselinePath);
    if (bytes === undefined) {
      fail("physical baseline is missing");
    }
    const digest = content.digest(bytes);
    if (
      digest !== observed.baselineDigest &&
      !equalBytes(bytes, content.bytes(observed.nativeCandidate))
    ) {
      fail(`physical baseline is neither exact B nor exact postimage: ${p.packageName}`);
    }
    physical.set(p.packageName, bytes);
  }
  return physical;
}

function createNativeMigrationPlan(
  consumerRoot: string,
  checks: ReadonlyMap<string, WriteDescription>,
  pending: readonly PendingWrite[],
  content: NativeTransitionContent,
): NativeMigrationPlan {
  const writes = pending.map((x) => Object.freeze({ ...x.description }));
  return Object.freeze({
    kind: "foundation:public-api-native-migration:version-plan:1" as const,
    writes: Object.freeze(writes),
    async apply() {
      // Preflight all paths before any mutation; each owning writer additionally
      // retains its exact cached preimage check at the individual write boundary.
      const complete = new Set<string>();
      for (const description of checks.values()) {
        let bytes: Uint8Array | undefined;
        bytes = await content.read(consumerRoot, description.destination);
        if (bytes === undefined && description.operation !== "create") {
          fail("baseline preimage is missing before migration application");
        }
        const digest = bytes === undefined ? null : content.digest(bytes);
        if (digest === description.proposedDigest) {
          complete.add(description.destination);
          continue;
        }
        if (digest !== description.preimageDigest) {
          fail("baseline preimage changed before migration application");
        }
      }
      for (const item of pending) {
        if (!complete.has(item.description.destination)) {
          await item.write();
        }
      }
    },
  });
}
