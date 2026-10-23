import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseStrictJson } from "@agent-teams/repository-mutation";
import {
  bindUnselectedCohortV3,
  type UnselectedCohortV3,
  type PackedManagedRuntimePolicy,
} from "../application-api.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManagedLane(
  value: unknown,
  expectedDefault: boolean,
): PackedManagedRuntimePolicy["lanes"]["node-24-production-default"] {
  if (!isRecord(value) || !isRecord(value.qualificationRuntime)) {
    throw new TypeError("Packed managed runtime policy lane is invalid.");
  }
  const qualificationRuntime = value.qualificationRuntime;
  if (
    typeof value.node !== "string" ||
    typeof value.default !== "boolean" ||
    value.default !== expectedDefault ||
    typeof qualificationRuntime.nodeVersion !== "string" ||
    typeof qualificationRuntime.pnpmVersion !== "string" ||
    typeof qualificationRuntime.platform !== "string" ||
    typeof qualificationRuntime.architecture !== "string"
  ) {
    throw new TypeError("Packed managed runtime policy lane is invalid.");
  }
  return {
    node: value.node,
    qualificationRuntime: {
      nodeVersion: qualificationRuntime.nodeVersion,
      pnpmVersion: qualificationRuntime.pnpmVersion,
      platform: qualificationRuntime.platform,
      architecture: qualificationRuntime.architecture,
    },
    default: expectedDefault,
  };
}

/** Projects only strict schema-validated policy byte strings; no selected authority is granted. */
export function parsePackedManagedRuntimePolicy(
  schemaInput: string,
  assetInput: string,
): PackedManagedRuntimePolicy {
  const policySchema = parseRecord(schemaInput);
  const asset = parseRecord(assetInput);
  const validatePolicy = new Ajv2020({ strict: true, allErrors: true }).compile(policySchema);
  if (!validatePolicy(asset)) {
    throw new TypeError("Packed managed runtime policy is invalid.");
  }
  const policyId = asset.policyId;
  const policyVersion = asset.policyVersion;
  const sourceDigest = asset.sourceDigest;
  if (
    policyId !== "agent-teams.docs-protocol-current-policy" ||
    policyVersion !== "3.0.0" ||
    typeof sourceDigest !== "string"
  ) {
    throw new TypeError("Packed runtime policy identity is invalid.");
  }
  const managed = asset.managedRuntime;
  const candidate = asset.managedCandidate;
  const lanes = isRecord(managed) ? managed.lanes : undefined;
  const pnpm = isRecord(managed) ? managed.pnpm : undefined;
  if (
    !isRecord(candidate) ||
    candidate.selected !== false ||
    candidate.status !== "candidate-unqualified" ||
    !isRecord(managed) ||
    managed.status !== "candidate-unqualified" ||
    typeof pnpm !== "string" ||
    !isRecord(lanes) ||
    Object.keys(lanes).toSorted().join("\u0000") !==
      ["node-24-production-default", "node-26-managed-qualified"].toSorted().join("\u0000") ||
    !Object.hasOwn(lanes, "node-24-production-default") ||
    !Object.hasOwn(lanes, "node-26-managed-qualified")
  ) {
    throw new TypeError("Packed managed runtime policy is incomplete or selected.");
  }
  return {
    policyId,
    policyVersion,
    sourceDigest,
    pnpm,
    lanes: {
      "node-24-production-default": parseManagedLane(lanes["node-24-production-default"], false),
      "node-26-managed-qualified": parseManagedLane(lanes["node-26-managed-qualified"], true),
    },
  };
}

export function parseRecord(source: string): Record<string, unknown> {
  const value = parseStrictJson(source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Cohort v3 JSON input must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Parses a candidate only; no selected authority or dispatcher consumes this result. */
export async function loadUnselectedCohortV3(source: string): Promise<UnselectedCohortV3> {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new TypeError("Unselected Cohort v3 exceeds the bounded input size.");
  }
  const schema = parseRecord(
    await readFile(
      new URL("../../../schemas/qualified-docs-cohort/v3.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile<UnselectedCohortV3>(schema);
  const candidate = parseRecord(source);
  if (!validate(candidate)) {
    throw new TypeError(`Invalid unselected Cohort v3: ${JSON.stringify(validate.errors)}`);
  }
  return bindUnselectedCohortV3(candidate, await loadPackedManagedRuntimePolicy());
}

export async function loadPackedManagedRuntimePolicy(): Promise<PackedManagedRuntimePolicy> {
  return parsePackedManagedRuntimePolicy(
    await readFile(
      new URL("../../../schemas/managed-runtime-policy/v1.schema.json", import.meta.url),
      "utf8",
    ),
    await readFile(new URL("../../../assets/runtime-policy.v1.json", import.meta.url), "utf8"),
  );
}

/** Creates a synchronous observer that reads the packed policy only when generation-4 evidence asks for it. */
export function createLazyPackedManagedRuntimePolicyObserver(): () => PackedManagedRuntimePolicy {
  let observed: PackedManagedRuntimePolicy | undefined;
  return function observePackedManagedRuntimePolicy(): PackedManagedRuntimePolicy {
    observed ??= parsePackedManagedRuntimePolicy(
      readFileSync(
        new URL("../../../schemas/managed-runtime-policy/v1.schema.json", import.meta.url),
        "utf8",
      ),
      readFileSync(new URL("../../../assets/runtime-policy.v1.json", import.meta.url), "utf8"),
    );
    return observed;
  };
}
