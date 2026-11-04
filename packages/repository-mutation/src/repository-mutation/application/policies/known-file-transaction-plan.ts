import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  type CanonicalJsonValue,
} from "../../../canonical-json.js";
import type {
  CompileKnownFileTransactionPlanInput,
  KnownFileImageV1,
  KnownFileTransactionOperationInput,
  KnownFileTransactionOperationV1,
  KnownFileTransactionPlanV1,
} from "../model/known-file-transaction.js";
import {
  findPortableRepositoryPathCollision,
  findPortableRepositoryPathOverlap,
  portableRepositoryPathProblem,
} from "../model/repository-path.js";

import { KnownFileTransactionPlanError } from "../model/known-file-transaction-error.js";
import {
  admitKnownFileCompileInput,
  type AdmittedKnownFileOperation,
} from "./known-file-plan-admission.js";
import { admitKnownFileWirePlan } from "./known-file-wire-plan-admission.js";

export { KnownFileTransactionPlanError } from "../model/known-file-transaction-error.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function image(bytes: Uint8Array, mode: number): KnownFileImageV1 {
  const copied = Buffer.from(bytes);
  return Object.freeze({
    contentBase64: copied.toString("base64"),
    digest: sha256Bytes(copied),
    mode,
    size: copied.byteLength,
  });
}

function compareImages(left: KnownFileImageV1, right: KnownFileImageV1): number {
  return binaryCompare(
    canonicalJson(left as unknown as CanonicalJsonValue),
    canonicalJson(right as unknown as CanonicalJsonValue),
  );
}

function compileOperation(operation: AdmittedKnownFileOperation): KnownFileTransactionOperationV1 {
  const problem = portableRepositoryPathProblem(operation.path);
  if (problem !== undefined) {
    throw new KnownFileTransactionPlanError(
      `Operation path ${operation.path} is not portable: ${problem}.`,
    );
  }
  if (operation.path.normalize("NFC") !== operation.path) {
    throw new KnownFileTransactionPlanError(
      `Operation path ${operation.path} must use NFC normalization.`,
    );
  }
  if (operation.path === ".agent-teams-local" || operation.path.startsWith(".agent-teams-local/")) {
    throw new KnownFileTransactionPlanError(
      `Operation path ${operation.path} overlaps Foundation's internal state namespace.`,
    );
  }
  if (operation.precondition.state === "absent") {
    return Object.freeze({
      path: operation.path,
      precondition: Object.freeze({ state: "absent" }),
      postimage: image(operation.postimage.bytes, operation.postimage.mode),
    });
  }
  const postimageMode = operation.postimage.mode;
  const acceptedPreimages = operation.precondition.acceptedPreimages
    .map((entry) => {
      if (entry.mode !== postimageMode) {
        throw new KnownFileTransactionPlanError(
          `${operation.path} replacement must preserve the exact file mode.`,
        );
      }
      return image(entry.bytes, entry.mode);
    })
    .toSorted(compareImages);
  for (let index = 1; index < acceptedPreimages.length; index += 1) {
    if (
      canonicalJson(acceptedPreimages[index - 1] as unknown as CanonicalJsonValue) ===
      canonicalJson(acceptedPreimages[index] as unknown as CanonicalJsonValue)
    ) {
      throw new KnownFileTransactionPlanError(
        `${operation.path} replacement contains a duplicate exact preimage.`,
      );
    }
  }
  const postimage = image(operation.postimage.bytes, postimageMode);
  return Object.freeze({
    path: operation.path,
    precondition: Object.freeze({
      state: "known-file",
      acceptedPreimages: Object.freeze(acceptedPreimages),
    }),
    postimage,
  });
}

function planBody(operations: readonly KnownFileTransactionOperationV1[]) {
  return {
    schemaVersion: 1 as const,
    protocol: "agent-teams.repository-mutation.known-file/v1" as const,
    operations,
  };
}

export function compileKnownFileTransactionPlan(
  input: CompileKnownFileTransactionPlanInput,
): KnownFileTransactionPlanV1 {
  const inputOperations = admitKnownFileCompileInput(input);
  const operations = inputOperations
    .map(compileOperation)
    .toSorted((left, right) => binaryCompare(left.path, right.path));
  const paths = operations.map(({ path }) => path);
  const collision = findPortableRepositoryPathCollision(paths);
  if (collision !== undefined) {
    throw new KnownFileTransactionPlanError(
      `Operation paths collide portably: ${collision.first} and ${collision.second}.`,
    );
  }
  const overlap = findPortableRepositoryPathOverlap(paths);
  if (overlap !== undefined) {
    throw new KnownFileTransactionPlanError(
      `Operation paths overlap as ancestor and descendant: ${overlap.ancestor} and ${overlap.descendant}.`,
    );
  }
  const frozenOperations = Object.freeze(operations);
  const body = planBody(frozenOperations);
  const planDigest = sha256Json({
    domain: "agent-teams.repository-mutation.known-file-plan/v1",
    body,
  } as unknown as CanonicalJsonValue);
  if (!SHA256.test(planDigest)) {
    throw new KnownFileTransactionPlanError("Compiled Plan digest is invalid.");
  }
  return Object.freeze({ ...body, planDigest });
}

/** Private owner snapshot: validation completes synchronously before filesystem work. */
export function snapshotKnownFileTransactionPlan(value: unknown): KnownFileTransactionPlanV1 {
  const admitted = admitKnownFileWirePlan(value);
  const reconstructed = compileKnownFileTransactionPlan({
    operations: admitted.operations.map((operation): KnownFileTransactionOperationInput => {
      const postimage = readImage(operation.postimage, `${operation.path} postimage`);
      if (operation.precondition.state === "absent") {
        return { path: operation.path, precondition: { state: "absent" }, postimage };
      }
      return {
        path: operation.path,
        precondition: {
          state: "known-file",
          acceptedPreimages: operation.precondition.acceptedPreimages.map((entry, index) =>
            readImage(entry, `${operation.path} preimage ${index}`),
          ),
        },
        postimage,
      };
    }),
  });
  if (
    canonicalJson(reconstructed as unknown as CanonicalJsonValue) !==
    canonicalJson(admitted as unknown as CanonicalJsonValue)
  ) {
    throw new KnownFileTransactionPlanError(
      "Known-file transaction Plan is not canonical or has an invalid digest.",
    );
  }
  return reconstructed;
}

export function assertKnownFileTransactionPlan(
  value: unknown,
): asserts value is KnownFileTransactionPlanV1 {
  snapshotKnownFileTransactionPlan(value);
}

function readImage(
  value: KnownFileImageV1,
  subject: string,
): { readonly bytes: Buffer; readonly mode: number } {
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (
    value.contentBase64 !== bytes.toString("base64") ||
    value.digest !== sha256Bytes(bytes) ||
    value.size !== bytes.byteLength
  ) {
    throw new KnownFileTransactionPlanError(`${subject} bytes or digest are invalid.`);
  }
  return { bytes, mode: value.mode };
}
