import { isAbsolute, relative, sep } from "node:path";
import { object, requireEqual, string, type JsonRecord } from "../stage-a/io.ts";
import { exactDigest } from "./context.ts";

export const contracts = {
  "wrong-controller": {
    operation: "finalize",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["externally retained controller requires actual Node24.22.3; no engine fallback."],
  },
  "wrong-target-runtime": {
    operation: "finalize",
    code: "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID",
    messages: ["Managed migration requires physical Node24.22.3 or Node26.12.1 on Linux/x64."],
  },
  "wrong-manager": {
    operation: "finalize",
    code: "DOCS_CONSUMER_UPGRADE_RUNTIME_INVALID",
    messages: ["Observed pnpm differs from the exact consumer packageManager pin."],
  },
  "lock-digest": {
    operation: "prepare",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["Target lock SHA256 differs from the selected bytes."],
  },
  "lock-foreign-scope": {
    operation: "prepare",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: [
      "lock migration changes non-owned policy, importers, dependencies or package graphs.",
    ],
  },
  "foreign-image": {
    operation: "finalize",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["current bytes or mode differ at "],
  },
  "pin-bytes": {
    operation: "finalize",
    code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
    messages: [
      "Preserved Node 26 pin must retain its exact original bytes.",
      "Preserved Node 26 pin bytes and mode must match the exact committed source image.",
    ],
  },
  "pin-mode": {
    operation: "finalize",
    code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
    messages: ["Preserved Node 26 pin bytes and mode must match the exact committed source image."],
  },
  "wrong-root": {
    operation: "finalize",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["preparation belongs to another consumer."],
  },
  "build-drift": {
    operation: "finalize",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["retain the exact external controller and kernel builds."],
  },
  "stale-preparation-digest": {
    operation: "finalize",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["preparation differs from separately selected digest."],
  },
  "stale-current-digest": {
    operation: "restore-committed",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["current selection differs from separately retained digest."],
  },
  "host-overlap": {
    operation: "restore-committed",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["committed managed postimage changed at "],
  },
  "stale-current-head": {
    operation: "restore-committed",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["current target HEAD/tree is stale.", "current target must be clean and committed."],
  },
  "completed-republish": {
    operation: "finalize",
    code: "DOCS_CONSUMER_EXECUTION_FAILURE",
    messages: ["completed selection cannot silently publish again after rollback."],
  },
} as const;
export type RefusalCase = keyof typeof contracts;
function selectedCase(value: unknown): RefusalCase {
  if (typeof value !== "string" || !Object.hasOwn(contracts, value)) {
    throw new Error("Select one supported actual public-CLI refusal case.");
  }
  return value as RefusalCase;
}
export function keys(value: JsonRecord, permitted: readonly string[], required = permitted): void {
  if (
    Object.keys(value).some((key) => !permitted.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("Unexpected selection keys.");
  }
}
export function external(path: string, roots: readonly string[]): void {
  for (const root of roots) {
    const relation = relative(root, path);
    if (
      relation === "" ||
      (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
    ) {
      throw new Error("Selected evidence must remain outside consumer and controller trees.");
    }
  }
}
export function relativeFile(value: unknown): string {
  const path = string(value, "selected relative fault path");
  if (
    isAbsolute(path) ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Fault path must be one contained repository-relative file.");
  }
  return path;
}
export function wrongDigest(value: unknown, actual: string): string {
  const selected = exactDigest(value, "deliberately mismatched selected digest");
  if (selected === actual) {
    throw new Error("Selected digest is not a mismatch.");
  }
  return selected;
}
export function readRefusalSelection(selection: JsonRecord) {
  keys(
    selection,
    [
      "schemaVersion",
      "operation",
      "refusalCase",
      "fault",
      "sourceRevision",
      "consumerRoot",
      "centralRoot",
      "authorityRevision",
      "candidate",
      "controllerInstallation",
      "node24Executable",
      "node26Executable",
      "corepackEntrypoint",
      "targetLock",
      "completionPath",
      "preparation",
      "currentRevision",
      "currentTree",
      "currentSelectionPath",
      "currentSelectionDigest",
    ],
    [
      "schemaVersion",
      "operation",
      "refusalCase",
      "fault",
      "sourceRevision",
      "consumerRoot",
      "centralRoot",
      "authorityRevision",
      "candidate",
      "controllerInstallation",
      "node24Executable",
      "node26Executable",
      "corepackEntrypoint",
      "targetLock",
      "completionPath",
    ],
  );
  requireEqual(selection["operation"], "refusal", "separate expected-refusal operation");
  const refusalCase = selectedCase(selection["refusalCase"]),
    contract = contracts[refusalCase];
  const fault = object(selection["fault"], "explicit finite fault selection");
  const faultKeys: readonly string[] = [
    "lock-digest",
    "stale-preparation-digest",
    "stale-current-digest",
  ].includes(refusalCase)
    ? ["wrongDigest"]
    : refusalCase === "lock-foreign-scope"
      ? ["changedLock"]
      : refusalCase === "foreign-image" || refusalCase === "host-overlap"
        ? ["path"]
        : refusalCase === "build-drift"
          ? ["path", "original"]
          : refusalCase === "wrong-manager"
            ? ["corepackHome"]
            : [];
  keys(fault, faultKeys);
  return { refusalCase, contract, fault };
}

export type RefusalSelection = ReturnType<typeof readRefusalSelection>;
