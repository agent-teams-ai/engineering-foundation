import type { QualityTopology } from "../api.js";
import {
  invalidQualityInput,
  qualityRecord,
  qualityString,
  qualityStrings,
} from "./quality-input-values.js";

const fields = new Set([
  "schemaVersion",
  "censusRoots",
  "packageRoots",
  "sourceRoots",
  "testRoots",
  "excludedRoots",
  "toolingFiles",
  "derivedFrom",
]);

function portablePath(value: string, allowRoot: boolean): string {
  if (allowRoot && value === ".") {
    return value;
  }
  if (
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("")
      .some(
        (character) =>
          character < " " || character.charCodeAt(0) === 127 || "*?[]{}".includes(character),
      ) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalidQualityInput("Topology paths must be bounded canonical repository-relative paths.");
  }
  return value;
}

function paths(value: unknown, allowRoot = true): readonly string[] {
  const result = qualityStrings(value).map((path) => portablePath(path, allowRoot));
  const identities = result.map((path) => path.normalize("NFC").toLocaleLowerCase("en-US"));
  if (new Set(identities).size !== result.length) {
    invalidQualityInput("Topology paths must have unique portable identities.");
  }
  return Object.freeze(result.toSorted());
}

function derivations(value: unknown): NonNullable<QualityTopology["derivedFrom"]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    invalidQualityInput("Topology derivedFrom must contain between 1 and 32 source bindings.");
  }
  const entries = value.map((item: unknown) => {
    const entry = qualityRecord(item);
    const path = portablePath(qualityString(entry["path"]), false);
    const sha256 = entry["sha256"];
    if (
      Object.keys(entry).some((key) => key !== "path" && key !== "sha256") ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      invalidQualityInput("Topology source bindings require only path and lowercase SHA-256.");
    }
    return Object.freeze({ path, sha256 });
  });
  paths(
    entries.map(({ path }) => path),
    false,
  );
  return Object.freeze(
    entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

/** Consumer facts only: no architectural standard or executable projection is loaded. */
export function mapQualityTopology(value: unknown): QualityTopology {
  const input = qualityRecord(value);
  if (input["schemaVersion"] !== 1 || Object.keys(input).some((key) => !fields.has(key))) {
    invalidQualityInput("Expected the closed quality-source-topology v1 contract.");
  }
  return Object.freeze({
    schemaVersion: 1,
    censusRoots: paths(input["censusRoots"]),
    packageRoots: paths(input["packageRoots"]),
    sourceRoots: paths(input["sourceRoots"]),
    testRoots: paths(input["testRoots"]),
    excludedRoots: paths(input["excludedRoots"]),
    toolingFiles: paths(input["toolingFiles"], false),
    ...(input["derivedFrom"] === undefined
      ? {}
      : { derivedFrom: derivations(input["derivedFrom"]) }),
  });
}
