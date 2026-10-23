import type { PublicApiItem, PublicApiSnapshot } from "./public-api.js";
import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";

export const nativeMigrationFrom = "7.58.12";
export const nativeMigrationTo = "typescript-native/7.0.2";
export type MigrationDigest = `sha256:${string}`;
export function nativeTransitionError(message: string): never {
  throw new Error(`Native public API migration: ${message}`);
}
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fail = nativeTransitionError;

export interface NativeMigrationPackageInput {
  readonly packageName: string;
  /** Original base Git bytes; never the candidate's editable replacement. */
  readonly baselineBytes: Uint8Array;
  readonly archiveBytes: Uint8Array;
  readonly configBytes: Uint8Array;
}
export interface NativeMigrationPackageObservation {
  readonly packageName: string;
  readonly baselineDigest: MigrationDigest;
  readonly archiveDigest: MigrationDigest;
  readonly archiveIntegrity: string;
  readonly configDigest: MigrationDigest;
  readonly releasedInputsDigest: MigrationDigest;
  readonly nativeReleasedDigest: MigrationDigest;
  readonly baseline: PublicApiSnapshot;
  readonly nativeReleased: PublicApiSnapshot;
  readonly nativeCandidate: PublicApiSnapshot;
}
export interface NativeMigrationToolDifference {
  readonly kind: "foundation:public-api-native-migration:tool-diff:1";
  readonly packages: readonly {
    readonly packageName: string;
    readonly from: string;
    readonly to: string;
    readonly entrypoints: readonly {
      readonly exportPath: string;
      readonly oldCount: number;
      readonly nativeCount: number;
      readonly removed: readonly string[];
      readonly added: readonly string[];
      readonly changed: readonly {
        readonly id: string;
        readonly before: PublicApiItem;
        readonly after: PublicApiItem;
        readonly structural: readonly string[];
      }[];
    }[];
  }[];
}
export interface NativeMigrationObservation {
  readonly kind: "foundation:public-api-native-migration:observation:1";
  readonly policyDigest: MigrationDigest;
  readonly toolchainIdentity: string;
  readonly packages: readonly NativeMigrationPackageObservation[];
  readonly toolDiff: NativeMigrationToolDifference;
  readonly toolDiffDigest: MigrationDigest;
  readonly typedDiagnostics: readonly FoundationDiagnostic[];
  readonly artifactDiagnostics: readonly FoundationDiagnostic[];
}

export function nativeMigrationToolDifference(
  packages: readonly Pick<
    NativeMigrationPackageObservation,
    "packageName" | "baseline" | "nativeReleased"
  >[],
): NativeMigrationToolDifference {
  return {
    kind: "foundation:public-api-native-migration:tool-diff:1",
    packages: packages
      .toSorted((a, b) => order(a.packageName, b.packageName))
      .map(({ packageName, baseline, nativeReleased }) => {
        if (
          baseline.extractorVersion !== nativeMigrationFrom ||
          nativeReleased.extractorVersion !== nativeMigrationTo ||
          baseline.packageName !== packageName ||
          nativeReleased.packageName !== packageName ||
          baseline.packageVersion !== nativeReleased.packageVersion
        ) {
          fail("historical observation identity mismatch");
        }
        if (
          JSON.stringify(baseline.entrypoints.map((x) => x.exportPath)) !==
          JSON.stringify(nativeReleased.entrypoints.map((x) => x.exportPath))
        ) {
          fail("historical export coverage changed");
        }
        return {
          packageName,
          from: baseline.extractorVersion,
          to: nativeReleased.extractorVersion,
          entrypoints: nativeReleased.entrypoints.map((entry, index) => {
            const previous = baseline.entrypoints[index]!;
            const before = new Map(previous.items.map((item) => [item.canonicalReference, item]));
            const after = new Map(entry.items.map((item) => [item.canonicalReference, item]));
            const removed = [...before.keys()].filter((id) => !after.has(id));
            const added = [...after.keys()].filter((id) => !before.has(id));
            const changed = [...before].flatMap(([id, value]) => {
              const next = after.get(id);
              if (next === undefined || JSON.stringify(value) === JSON.stringify(next)) {
                return [];
              }
              const structural = [...new Set([...Object.keys(value), ...Object.keys(next)])].filter(
                (key) =>
                  key !== "signature" &&
                  JSON.stringify(value[key as keyof PublicApiItem]) !==
                    JSON.stringify(next[key as keyof PublicApiItem]),
              );
              return [{ id, before: value, after: next, structural }];
            });
            if (
              removed.length > 0 ||
              added.length > 0 ||
              changed.some((item) => item.structural.length > 0)
            ) {
              fail(
                `historical item identity/kind/parent loss or addition in ${packageName} ${entry.exportPath}`,
              );
            }
            return {
              exportPath: entry.exportPath,
              oldCount: before.size,
              nativeCount: after.size,
              removed,
              added,
              changed,
            };
          }),
        };
      }),
  };
}

export interface NativeMigrationReview {
  readonly kind: "foundation:public-api-native-migration:review:1";
  readonly from: typeof nativeMigrationFrom;
  readonly to: typeof nativeMigrationTo;
  readonly baselineSourceCommit: string;
  readonly policyDigest: MigrationDigest;
  readonly toolDiffDigest: MigrationDigest;
  readonly packages: readonly {
    readonly packageName: string;
    readonly baselinePath: string;
    readonly baselineDigest: MigrationDigest;
    readonly archiveDigest: MigrationDigest;
    readonly archiveIntegrity: string;
    readonly configDigest: MigrationDigest;
    readonly releasedInputsDigest: MigrationDigest;
    readonly nativeReleasedDigest: MigrationDigest;
  }[];
}
