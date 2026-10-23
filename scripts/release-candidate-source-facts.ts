import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ExpectedInputs,
  JsonRecord,
  ManifestSnapshot,
  PermittedChange,
  ReleaseIntent,
  ReleaseType,
  WorkspacePackage,
} from "../packages/release-checks/dist/index.js";
import type { ChangesetsReleasePlan } from "./npm-package-bootstrap-release-plan.mts";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";
import {
  readReleaseGitFile,
  releaseJsonDigest,
  releaseObject,
  releaseTreeDigest,
  requireReleaseFile,
  type ChangesetsInstallation,
  type ReleaseFileBytes,
  type ReleaseGitAuthority,
  type ReleaseTree,
} from "./release-candidate-observation.ts";

const ordinary = { type: "file", mode: "100644" } as const;
// Changesets 2.31.1 reads direct non-hidden .md files and ignores README case-insensitively.
const intentPattern = /^\.changeset\/[^./][^/]*\.md$/u;
const baselinePattern =
  /^architecture\/(?:public-api\/[^/]+\.json|contracts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:json|ya?ml))$/u;
export type ReadReleaseFile = (path: string) => Promise<ReleaseFileBytes | null>;

function fail(message: string): never {
  throw new Error(`Release candidate rejected: ${message}`);
}
export function snapshot(file: ReleaseFileBytes | null, path: string): ManifestSnapshot | null {
  return file === null ? null : { file: file.file, semantic: releaseObject(file.bytes, path) };
}
export async function stateAt(read: ReadReleaseFile): Promise<JsonRecord | undefined> {
  const file = await read(".changeset/pre.json");
  return file === null ? undefined : releaseObject(file.bytes, ".changeset/pre.json");
}

function workspacePaths(tree: ReleaseTree, root: JsonRecord): readonly string[] {
  const workspace = root["workspaces"];
  const patterns = Array.isArray(workspace)
    ? workspace
    : workspace !== null && typeof workspace === "object" && !Array.isArray(workspace)
      ? (workspace as JsonRecord)["packages"]
      : undefined;
  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern) => typeof pattern !== "string" || !/^[^/*]+\/\*$/u.test(pattern))
  ) {
    fail("the Foundation Host requires explicit one-level workspace patterns.");
  }
  const parents = patterns.map((pattern) => (pattern as string).slice(0, -2));
  return [
    "package.json",
    ...[...tree.keys()]
      .filter((path) => {
        const parts = path.split("/");
        return parts.length === 3 && parts[2] === "package.json" && parents.includes(parts[0]!);
      })
      .toSorted(),
  ];
}

export async function inventory(
  tree: ReleaseTree,
  read: ReadReleaseFile,
  config: JsonRecord,
): Promise<readonly WorkspacePackage[]> {
  const root = releaseObject(
    (await requireReleaseFile(read, "package.json")).bytes,
    "package.json",
  );
  const ignored = config["ignore"];
  if (!Array.isArray(ignored) || ignored.some((value) => typeof value !== "string")) {
    fail("Changesets ignore must be an explicit package inventory.");
  }
  const privateOptions = config["privatePackages"];
  if (
    privateOptions === null ||
    typeof privateOptions !== "object" ||
    Array.isArray(privateOptions) ||
    typeof (privateOptions as JsonRecord)["version"] !== "boolean"
  ) {
    fail("Changesets private package versioning must be explicit.");
  }
  const packages: WorkspacePackage[] = [];
  for (const path of workspacePaths(tree, root)) {
    const before = snapshot(await requireReleaseFile(read, path), path)!;
    const name = before.semantic["name"];
    if (typeof name !== "string" || name === "") {
      fail(`${path} has no package identity.`);
    }
    const classification = before.semantic["private"] === true ? "private" : "public";
    const versioning = ignored.includes(name)
      ? "ignored"
      : path === "package.json" ||
          typeof before.semantic["version"] !== "string" ||
          (classification === "private" && !(privateOptions as JsonRecord)["version"])
        ? "unversioned"
        : "versioned";
    const catalogEntry = PUBLISHABLE_PACKAGES.find(
      (entry: { readonly name: string }) => entry.name === name,
    ) as { readonly manifestPath: string } | undefined;
    if (
      classification === "public" &&
      (catalogEntry === undefined || catalogEntry.manifestPath !== path)
    ) {
      fail(`${path} does not match the publishable catalog.`);
    }
    packages.push({
      name,
      root: path === "package.json" ? "." : path.slice(0, -"/package.json".length),
      manifestPath: path,
      classification,
      versioning,
      before,
    });
  }
  return packages;
}

/** Read raw source intents independently of the engine's selected plan. */
export async function sourceIntents(
  tree: ReleaseTree,
  read: ReadReleaseFile,
  pre: JsonRecord | undefined,
): Promise<readonly ReleaseIntent[]> {
  const applied =
    pre?.["mode"] === "pre" && Array.isArray(pre["changesets"]) ? pre["changesets"] : [];
  const intents: ReleaseIntent[] = [];
  for (const path of [...tree.keys()]
    .filter((entry) => intentPattern.test(entry) && !/^README\.md$/iu.test(basename(entry)))
    .toSorted()) {
    const file = await requireReleaseFile(read, path);
    const source = file.bytes.toString("utf8").replaceAll("\r\n", "\n");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
    const empty = /^---\n---\n[\s\S]*$/u.test(source);
    if (!empty && match === null) {
      fail(`${path} has unsupported Changesets frontmatter.`);
    }
    const value: unknown = empty ? {} : parseYaml(match![1]!);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${path} must request package release types.`);
    }
    const requests = Object.entries(value).map(([packageName, type]) => {
      if (!["major", "minor", "patch"].includes(String(type))) {
        fail(`${path} has an unsupported release type.`);
      }
      return { packageName, type: type as ReleaseType };
    });
    const id = basename(path).replace(".md", "");
    intents.push({
      id,
      path,
      digest: file.file.digest,
      participation: applied.includes(id) ? "retained" : "pending",
      requests,
    });
  }
  return intents;
}

function intentConsumptions(
  plan: ChangesetsReleasePlan,
  packages: readonly WorkspacePackage[],
  intents: readonly ReleaseIntent[],
  pre: JsonRecord | undefined,
): ExpectedInputs["plan"]["consumptions"] {
  if (!plan.releases.some((entry) => entry.oldVersion !== entry.newVersion)) {
    return [];
  }
  const selected = new Set(plan.changesets.map((intent) => intent.id));
  return intents
    .filter(
      (intent) =>
        selected.has(intent.id) &&
        intent.participation === "pending" &&
        intent.requests.every(
          (request) =>
            packages.find((pkg) => pkg.name === request.packageName)?.versioning === "versioned",
        ),
    )
    .map((intent) => ({
      intentId: intent.id,
      effect:
        pre?.["mode"] === "pre"
          ? { kind: "record" as const, evidencePath: ".changeset/pre.json" }
          : { kind: "remove" as const },
    }));
}

export async function permittedChanges(
  tree: ReleaseTree,
  read: ReadReleaseFile,
  packages: readonly WorkspacePackage[],
  intents: readonly ReleaseIntent[],
  pre: JsonRecord | undefined,
): Promise<readonly PermittedChange[]> {
  const allowed = new Map<string, PermittedChange>();
  const admit = (
    path: string,
    classification: string,
    contentAuthority: string,
    deletion = false,
  ): void => {
    const before = tree.get(path)?.shape ?? null;
    allowed.set(path, {
      path,
      classification,
      contentAuthority,
      kind: deletion ? "deleted" : before === null ? "added" : "modified",
      before,
      after: deletion ? null : ordinary,
    });
  };
  for (const pkg of packages) {
    admit(pkg.manifestPath, "manifest", "release-checks:version-only");
    if (pkg.classification === "public") {
      admit(`${pkg.root}/CHANGELOG.md`, "changelog", "foundation:release-content");
    }
  }
  for (const intent of intents) {
    admit(intent.path, "intent", "release-checks:consumption", true);
  }
  if (pre !== undefined) {
    admit(
      ".changeset/pre.json",
      "prerelease",
      "foundation:prerelease-content",
      pre["mode"] === "exit",
    );
  }
  if (tree.has("bun.lock")) {
    admit("bun.lock", "lock", "foundation:release-bun-lock");
  }
  // Baseline destinations are accepted policy fields, never paths discovered in generated output.
  const destinations = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (
          key === "releasedBaselinePath" &&
          typeof entry === "string" &&
          baselinePattern.test(entry)
        ) {
          destinations.add(entry);
        } else {
          visit(entry);
        }
      }
    }
  };
  for (const path of [...tree.keys()].filter((entry) =>
    /^architecture\/foundation\/[^/]+\.(?:json|ya?ml)$/u.test(entry),
  )) {
    const file = await requireReleaseFile(read, path);
    visit(parseYaml(file.bytes.toString("utf8")));
  }
  for (const path of [...destinations].toSorted()) {
    admit(path, "baseline", "foundation:released-baseline");
  }
  return [...allowed.values()].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function inventoryDigest(packages: readonly WorkspacePackage[]): string {
  return releaseJsonDigest(packages.map(({ before: _before, ...identity }) => identity));
}

export async function expectedInputs(
  authority: ReleaseGitAuthority,
  tree: ReleaseTree,
  plan: ChangesetsReleasePlan,
  installation: ChangesetsInstallation,
): Promise<ExpectedInputs> {
  const read = (path: string) => readReleaseGitFile(authority, tree, path);
  const configFile = await requireReleaseFile(read, ".changeset/config.json");
  const config = releaseObject(configFile.bytes, ".changeset/config.json");
  const pre = await stateAt(read);
  const packages = await inventory(tree, read, config);
  const intents = await sourceIntents(tree, read, pre);
  const permitted = await permittedChanges(tree, read, packages, intents, pre);
  const releases = plan.releases.map((release) => {
    const pkg = packages.find((candidate) => candidate.name === release.name);
    if (pkg === undefined) {
      fail(`official plan references unknown package ${release.name}.`);
    }
    return {
      packageName: release.name,
      manifestPath: pkg.manifestPath,
      type: release.type,
      oldVersion: release.oldVersion ?? null,
      newVersion: release.newVersion ?? null,
      intentIds: release.changesets,
    };
  });
  const normalizedPlan = {
    releases,
    consumptions: intentConsumptions(plan, packages, intents, pre),
  };
  return {
    packages,
    intents,
    plan: normalizedPlan,
    permittedChanges: permitted,
    binding: {
      source: {
        repository: "agent-teams-ai/engineering-foundation",
        identity: authority.sourceCommit,
        digest: releaseTreeDigest(tree),
      },
      engine: {
        name: installation.name,
        version: installation.version,
        digest: installation.digest,
      },
      configDigest: configFile.file.digest,
      inventoryDigest: inventoryDigest(packages),
      policyDigest: releaseJsonDigest(permitted),
      intentsDigest: releaseJsonDigest(intents),
      planDigest: releaseJsonDigest(normalizedPlan),
    },
  };
}
