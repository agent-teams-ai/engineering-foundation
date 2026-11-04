import type {
  KnownFileDigest,
  KnownFileImageV1,
  KnownFileTransactionOperationV1,
  KnownFileTransactionPlanV1,
} from "../model/known-file-transaction.js";
import { KnownFileTransactionPlanError } from "../model/known-file-transaction-error.js";
import {
  assertKnownFileKeys,
  chargeKnownFileImage,
  knownFileInputArray,
  knownFileInputRecord,
  knownFileMode,
  maximumKnownFileImageBytes,
  maximumKnownFileOperations,
  maximumKnownFilePreimages,
} from "./known-file-plan-admission.js";

function isDigest(value: unknown): value is KnownFileDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function decodedLength(content: string, subject: string): number {
  const maximum = 4 * Math.ceil(maximumKnownFileImageBytes / 3);
  if (content.length > maximum || content.length % 4 !== 0) {
    throw new KnownFileTransactionPlanError(`${subject} bytes or digest are invalid.`);
  }
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const end = content.length - padding;
  // A linear scan avoids an unbounded regexp stack on an admitted 8 MiB image.
  for (let index = 0; index < end; index += 1) {
    const code = content.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      throw new KnownFileTransactionPlanError(`${subject} bytes or digest are invalid.`);
    }
  }
  return (content.length / 4) * 3 - padding;
}

function wireImage(value: unknown, budget: { bytes: number }, subject: string): KnownFileImageV1 {
  const image = knownFileInputRecord(value, subject);
  assertKnownFileKeys(image, ["contentBase64", "digest", "mode", "size"], subject);
  const contentBase64 = image["contentBase64"];
  const digest = image["digest"];
  const size = image["size"];
  if (
    typeof contentBase64 !== "string" ||
    !isDigest(digest) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size !== decodedLength(contentBase64, subject)
  ) {
    throw new KnownFileTransactionPlanError(`${subject} bytes or digest are invalid.`);
  }
  chargeKnownFileImage(budget, size, subject);
  return Object.freeze({
    contentBase64,
    digest,
    mode: knownFileMode(image["mode"], subject),
    size,
  });
}

function wireOperation(value: unknown, budget: { bytes: number }): KnownFileTransactionOperationV1 {
  const operation = knownFileInputRecord(value, "Known-file transaction operation");
  assertKnownFileKeys(
    operation,
    ["path", "precondition", "postimage"],
    "Known-file transaction operation",
  );
  const path = operation["path"];
  if (typeof path !== "string") {
    throw new KnownFileTransactionPlanError("Operation path must be a string.");
  }
  const precondition = knownFileInputRecord(operation["precondition"], `${path} precondition`);
  if (precondition["state"] === "absent") {
    assertKnownFileKeys(precondition, ["state"], `${path} precondition`);
    return Object.freeze({
      path,
      precondition: Object.freeze({ state: "absent" }),
      postimage: wireImage(operation["postimage"], budget, `${path} postimage`),
    });
  }
  if (precondition["state"] !== "known-file") {
    throw new KnownFileTransactionPlanError(`${path} precondition is invalid.`);
  }
  assertKnownFileKeys(precondition, ["state", "acceptedPreimages"], `${path} precondition`);
  const accepted = knownFileInputArray(
    precondition["acceptedPreimages"],
    maximumKnownFilePreimages,
    `${path} replacement preimages`,
  );
  if (accepted.length === 0) {
    throw new KnownFileTransactionPlanError(
      `${path} replacement requires at least one exact preimage.`,
    );
  }
  return Object.freeze({
    path,
    precondition: Object.freeze({
      state: "known-file",
      acceptedPreimages: Object.freeze(
        accepted.map((entry, index) => wireImage(entry, budget, `${path} preimage ${index}`)),
      ),
    }),
    postimage: wireImage(operation["postimage"], budget, `${path} postimage`),
  });
}

/** Own the closed wire shape and preflight all counts/bytes before decoding. */
export function admitKnownFileWirePlan(value: unknown): KnownFileTransactionPlanV1 {
  const plan = knownFileInputRecord(value, "Known-file transaction Plan");
  assertKnownFileKeys(
    plan,
    ["schemaVersion", "protocol", "operations", "planDigest"],
    "Known-file transaction Plan",
  );
  const digest = plan["planDigest"];
  if (
    plan["schemaVersion"] !== 1 ||
    plan["protocol"] !== "agent-teams.repository-mutation.known-file/v1" ||
    !isDigest(digest)
  ) {
    throw new KnownFileTransactionPlanError("Known-file transaction Plan is invalid.");
  }
  const operations = knownFileInputArray(
    plan["operations"],
    maximumKnownFileOperations,
    "A transaction",
  );
  const budget = { bytes: 0 };
  return Object.freeze({
    schemaVersion: 1,
    protocol: "agent-teams.repository-mutation.known-file/v1",
    operations: Object.freeze(operations.map((entry) => wireOperation(entry, budget))),
    planDigest: digest,
  });
}
