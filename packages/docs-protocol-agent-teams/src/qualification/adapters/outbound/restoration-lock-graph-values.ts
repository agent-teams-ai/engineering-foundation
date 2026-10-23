import { posix } from "node:path";
import {
  type JsonObject,
  type JsonValue,
} from "../../application/model/restoration-lock-inputs.js";
export type Path = readonly (string | number)[];
export type Edges = Readonly<Record<string, string>>;
type RootBinding = JsonObject & { readonly specifier: string; readonly version: string };
export type Importer = JsonObject & {
  readonly dependencies?: Readonly<Record<string, RootBinding>>;
  readonly devDependencies?: Readonly<Record<string, RootBinding>>;
  readonly optionalDependencies?: Readonly<Record<string, RootBinding>>;
};
type Package = JsonObject & {
  readonly resolution: JsonObject & { readonly integrity: string };
};
export type Snapshot = JsonObject & {
  readonly dependencies?: Edges;
  readonly optionalDependencies?: Edges;
};
export type Lock = JsonObject & {
  readonly lockfileVersion: "9.0";
  readonly importers: Readonly<Record<string, Importer>>;
  readonly packages: Readonly<Record<string, Package>>;
  readonly snapshots: Readonly<Record<string, Snapshot>>;
};
export const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;
export const roots: Edges = {
  "@agent-teams/docs-protocol": "0.6.0",
  "@agent-teams/docs-protocol-agent-teams": "0.2.9",
  "@agent-teams/engineering-foundation": "1.4.0",
};
export const claims = [
  ...Object.entries(roots).map(([name, version]) => `${name}@${version}`),
  "@agent-teams/document-authoring@0.3.0",
  "@agent-teams/repository-mutation@0.2.0",
];
export const contexts = [
  "@agent-teams/engineering-foundation@1.4.0",
  "@microsoft/api-extractor@7.58.12",
  "@microsoft/api-extractor-model@7.33.10",
  "@rushstack/node-core-library@5.23.3",
  "@rushstack/problem-matcher@0.2.1",
  "@rushstack/terminal@0.24.2",
  "@rushstack/ts-command-line@5.3.12",
];
export const seeds = [
  "@rushstack/node-core-library@5.23.3",
  "@rushstack/problem-matcher@0.2.1",
  "@rushstack/terminal@0.24.2",
];
export const nodeTypes = "@types/node@24.13.3";
export const undici = "undici-types@7.18.2";
export const suffix = "(@types/node@24.13.3)";
export const formats = "ajv-formats@3.0.1";
export const formatsPeer = formats + "(ajv@8.20.0)";
export const covered = [
  ...contexts,
  nodeTypes,
  undici,
  "ajv@8.20.0",
  formats,
  "ajv-draft-04@1.0.0",
];

export class Refusal extends Error {
  readonly path: Path;
  constructor(message: string, path: Path) {
    super(message);
    this.path = path;
  }
}
export function need(value: unknown, message: string, path: Path = []): asserts value {
  const accepted = Boolean(value);
  if (!accepted) {
    throw new Refusal(message, path);
  }
}
export function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}
export function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !isList(value);
}
export function object(value: JsonValue | undefined): JsonObject {
  need(isObject(value), "expected record");
  return value;
}
function isEdges(value: JsonObject): value is JsonObject & Edges {
  return Object.values(value).every((item) => typeof item === "string");
}
export function strings(value: JsonValue | undefined): Edges {
  const row = object(value);
  need(isEdges(row), "expected string edges");
  return row;
}
export function names(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  need(
    actual.length === expected.length &&
      new Set(actual).size === actual.length &&
      actual.toSorted().join("\0") === expected.toSorted().join("\0"),
    message,
  );
}
export function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  need(value !== null && typeof value === "object", "request records must be plain data");
  need(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "request records must be plain data",
  );
  names(
    Reflect.ownKeys(value).map((key) => {
      need(typeof key === "string", "symbol request key");
      return key;
    }),
    keys,
    "unexpected or missing request field",
  );
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    need(
      Object.hasOwn(descriptor, "value") && descriptor.enumerable === true,
      "request accessor or hidden field",
    );
  }
}

export function locator(text: string) {
  const cut = text.indexOf("("),
    coordinate = cut < 0 ? text : text.slice(0, cut);
  const context = cut < 0 ? "" : text.slice(cut);
  const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/.exec(coordinate);
  need(
    match !== null &&
      typeof match[1] === "string" &&
      match[1].length > 0 &&
      typeof match[2] === "string" &&
      match[2].length > 0,
    "unsupported locator: " + text,
  );
  let end = 0;
  const peers = new Set<string>();
  for (const peer of context.matchAll(/\(((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@\d+\.\d+\.\d+\)/g)) {
    need(
      peer.index === end &&
        typeof peer[1] === "string" &&
        peer[1].length > 0 &&
        !peers.has(peer[1]),
      "ambiguous context: " + text,
    );
    peers.add(peer[1]);
    end += peer[0].length;
  }
  need(end === context.length, "unsupported context: " + text);
  return { coordinate, context, name: match[1], version: match[2] };
}
export function edge(name: string, version: string): string {
  const id = `${name}@${version}`;
  need(locator(id).name === name, "edge identity");
  return id;
}
export function edges(row: Snapshot): readonly (readonly [string, string])[] {
  return [
    ...Object.entries(row.dependencies ?? {}),
    ...Object.entries(row.optionalDependencies ?? {}),
  ];
}
function assertLock(tree: JsonObject): asserts tree is Lock {
  need(tree.lockfileVersion === "9.0", "pnpm-v9 string lockfileVersion", ["lockfileVersion"]);
  const importers = object(tree.importers),
    packages = object(tree.packages),
    snapshots = object(tree.snapshots);
  for (const [id, value] of Object.entries(importers)) {
    const importer = object(value);
    for (const section of sections) {
      if (!Object.hasOwn(importer, section)) {
        continue;
      }
      for (const [name, item] of Object.entries(object(importer[section]))) {
        const binding = object(item);
        need(
          typeof binding.specifier === "string" && typeof binding.version === "string",
          "importer binding",
          [id, section, name],
        );
        if (!binding.version.startsWith("link:")) {
          edge(name, binding.version);
        }
      }
    }
  }
  for (const [id, value] of Object.entries(packages)) {
    need(locator(id).context === "", "package coordinate has context");
    need(typeof object(object(value).resolution).integrity === "string", "package resolution", [
      "packages",
      id,
    ]);
  }
  for (const [id, value] of Object.entries(snapshots)) {
    need(Object.hasOwn(packages, locator(id).coordinate), "snapshot has no package", [
      "snapshots",
      id,
    ]);
    const row = object(value),
      seen = new Set<string>();
    for (const section of ["dependencies", "optionalDependencies"]) {
      if (!Object.hasOwn(row, section)) {
        continue;
      }
      for (const [name, version] of Object.entries(strings(row[section]))) {
        need(!seen.has(name), "dependency occurs in two sections", ["snapshots", id, name]);
        seen.add(name);
        edge(name, version);
      }
    }
    if (Object.hasOwn(row, "transitivePeerDependencies")) {
      const peers = row.transitivePeerDependencies;
      need(isList(peers) && peers.every((peer) => typeof peer === "string"), "transitive peers", [
        "snapshots",
        id,
      ]);
    }
  }
}
export function lock(tree: JsonObject): Lock {
  assertLock(tree);
  return tree;
}

export function starts(tree: Lock, foreign: boolean): string[] {
  const result: string[] = [];
  for (const [id, importer] of Object.entries(tree.importers)) {
    for (const section of sections) {
      for (const [name, binding] of Object.entries(importer[section] ?? {})) {
        if (foreign && id === "." && Object.hasOwn(roots, name)) {
          continue;
        }
        if (!binding.version.startsWith("link:")) {
          result.push(edge(name, binding.version));
          continue;
        }
        const target = posix.normalize(posix.join(id === "." ? "" : id, binding.version.slice(5)));
        need(
          !posix.isAbsolute(target) &&
            target !== ".." &&
            !target.startsWith("../") &&
            Object.hasOwn(tree.importers, target),
          "unbound workspace link",
        );
      }
    }
  }
  return result;
}
export function managedStarts(tree: Lock): string[] {
  const importer = tree.importers["."];
  need(importer, "missing managed importer");
  for (const section of ["dependencies", "optionalDependencies"]) {
    need(
      !Object.keys(object(importer[section] ?? {})).some((name) => Object.hasOwn(roots, name)),
      "moved managed root",
    );
  }
  return Object.keys(roots).map((name) => {
    const binding = importer.devDependencies?.[name];
    need(binding, "missing managed root");
    return edge(name, binding.version);
  });
}
export function reach(tree: Lock, initial: readonly string[]): Set<string> {
  const found = new Set<string>(),
    pending = [...initial];
  while (pending.length) {
    const id = pending.pop();
    need(id !== undefined && id.length > 0, "reach cursor");
    if (found.has(id)) {
      continue;
    }
    const row = tree.snapshots[id];
    need(row, "dangling locator", ["snapshots", id]);
    found.add(id);
    for (const [name, version] of edges(row)) {
      pending.push(edge(name, version));
    }
  }
  return found;
}
export function rooted(tree: Lock): Set<string> {
  const found = reach(tree, starts(tree, false));
  names([...found], Object.keys(tree.snapshots), "unreachable snapshot");
  names(
    [...new Set([...found].map((id) => locator(id).coordinate))],
    Object.keys(tree.packages),
    "unused package",
  );
  return found;
}

export function canonical(value: JsonValue): string {
  if (isList(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (isObject(value)) {
    return (
      "{" +
      Object.keys(value)
        .toSorted()
        .map((key) => {
          const item = value[key];
          need(item !== undefined, "canonical own value");
          return JSON.stringify(key) + ":" + canonical(item);
        })
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export function same(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  message: string,
): void {
  need(left !== undefined && right !== undefined && canonical(left) === canonical(right), message);
}
export function kind(value: JsonValue | undefined): string {
  return value === undefined
    ? "absent"
    : value === null
      ? "null"
      : isList(value)
        ? "array"
        : typeof value;
}
