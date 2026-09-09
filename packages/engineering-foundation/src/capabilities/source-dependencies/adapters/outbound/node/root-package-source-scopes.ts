import { join, posix } from "node:path";

import { compareBinaryStrings } from "../../../../../binary-string-comparator.js";
import { assertSourceTopologyActive as assertActive, sourceTopologyInputError as inputError } from "../../../api.js";
import { isPureModuleTypeScope, sourcePackageOwner, type SourcePackageOwnership } from "../../../application/policies/source-package-ownership.js";
import { portableRepositoryPathIdentity } from "../../../application/model/repository-path.js";
import { recordDiscoveryEntry, type DiscoveryBudget, type SourceWorkspaceDiscoveryLimits } from "./selected-package-source-discovery.js";
import { captureStableRepositoryPath, revalidateStableRepositoryPath, type SourceWorkspaceFileSystem, type StableRepositoryPath } from "./source-workspace-filesystem.js";

interface ManifestObservation {
  readonly path: string;
  readonly parent: StableRepositoryPath;
  readonly captured?: StableRepositoryPath;
  readonly bytes?: Uint8Array;
  readonly kind: "absent" | "module-type-scope" | "package-authority";
  readonly moduleType?: "commonjs" | "module";
}

/** One bounded observation ledger brackets discovery, inventory and source reads. */
export class RootPackageSourceScopes {
  readonly #root: string;
  readonly #files: SourceWorkspaceFileSystem;
  readonly #limits: SourceWorkspaceDiscoveryLimits;
  readonly #signal: AbortSignal | undefined;
  readonly #observations = new Map<string, ManifestObservation>();
  readonly #portablePaths = new Map<string, string>();
  readonly #parents = new Map<string, StableRepositoryPath>();
  readonly budget: DiscoveryBudget = { entries: 0, manifests: 0, sourceFiles: 0, observedEntries: new Set() };
  #bytes = 0;

  constructor(root: string, files: SourceWorkspaceFileSystem, limits: SourceWorkspaceDiscoveryLimits, signal?: AbortSignal) {
    this.#root = root;
    this.#files = files;
    this.#limits = limits;
    this.#signal = signal;
  }

  get manifestBytes(): number { return this.#bytes; }

  async #read(path: string): Promise<Uint8Array> {
    assertActive(this.#signal);
    const bytes = await this.#files.readContainedFile({
      candidate: join(this.#root, path),
      maxBytes: Math.min(2 * 1024 * 1024, this.#limits.maxSourceFileBytes),
      root: this.#root
    });
    assertActive(this.#signal);
    if (bytes.byteLength > Math.min(2 * 1024 * 1024, this.#limits.maxSourceFileBytes)) {
      inputError("WORKSPACE_LIMIT_EXCEEDED", `Package manifest exceeds the byte limit: ${path}.`);
    }
    return bytes;
  }

  async observe(path: string): Promise<boolean> {
    assertActive(this.#signal);
    const existing = this.#observations.get(path);
    if (existing !== undefined) {
      return existing.kind === "package-authority";
    }
    const identity = portableRepositoryPathIdentity(path);
    const prior = this.#portablePaths.get(identity);
    if (prior !== undefined && prior !== path) {
      inputError("PACKAGE_PATH_CASE_COLLISION", `Manifest paths share portable identity: ${prior} and ${path}.`);
    }
    this.#portablePaths.set(identity, path);
    recordDiscoveryEntry(path, this.budget, this.#limits);
    const parentPath = posix.dirname(path);
    let parent = this.#parents.get(parentPath);
    if (parent === undefined) {
      parent = await captureStableRepositoryPath(this.#root, parentPath, "directory", this.#files, this.#signal);
      if (parent.traversesSymbolicLink) {
        inputError("SOURCE_SYMLINK_PROHIBITED", `Manifest ancestor traverses a symbolic link: ${path}.`);
      }
      this.#parents.set(parentPath, parent);
    }
    let absent = false;
    try {
      await this.#files.lstat(join(this.#root, path));
    } catch (error) {
      assertActive(this.#signal);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        inputError("PACKAGE_MANIFEST_INVALID", `Package manifest is unavailable: ${path}.`);
      }
      absent = true;
    }
    if (absent) {
      this.#observations.set(path, { path, parent, kind: "absent" });
      return false;
    }
    if (this.budget.manifests >= this.#limits.maxManifestFiles) {
      inputError("WORKSPACE_LIMIT_EXCEEDED", `Workspace contains too many package manifests: ${path}.`);
    }
    this.budget.manifests += 1;
    const captured = await captureStableRepositoryPath(this.#root, path, "source", this.#files, this.#signal);
    if (captured.traversesSymbolicLink) {
      inputError("SOURCE_SYMLINK_PROHIBITED", `Package manifest traverses a symbolic link: ${path}.`);
    }
    if (!captured.canonicalMetadata.isFile()) {
      inputError("PACKAGE_MANIFEST_INVALID", `Package manifest must be a file: ${path}.`);
    }
    let bytes: Uint8Array;
    let value: unknown;
    try {
      bytes = await this.#read(path);
      value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
      assertActive(this.#signal);
      inputError("PACKAGE_MANIFEST_INVALID", `Package manifest is unavailable or invalid: ${path}.`);
    }
    this.#bytes += bytes.byteLength;
    if (this.#bytes > this.#limits.maxTotalSourceBytes) {
      inputError("WORKSPACE_LIMIT_EXCEEDED", `Manifest observations exceed the total byte limit: ${path}.`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      inputError("PACKAGE_MANIFEST_INVALID", `Package manifest must contain an object: ${path}.`);
    }
    const object = value as Record<string, unknown>;
    const kind = path !== "package.json" && isPureModuleTypeScope(object)
      ? "module-type-scope" : "package-authority";
    await revalidateStableRepositoryPath(this.#root, captured, this.#files, this.#signal);
    this.#observations.set(path, {
      path, parent, captured, bytes: Uint8Array.from(bytes), kind,
      moduleType: object["type"] === "module" ? "module" : "commonjs"
    });
    return kind === "package-authority";
  }

  async observeAncestry(roots: readonly string[]): Promise<void> {
    for (const root of roots.toSorted(compareBinaryStrings)) {
      let directory = root;
      for (;;) {
        await this.observe(directory === "." ? "package.json" : `${directory}/package.json`);
        if (directory === ".") { break; }
        directory = posix.dirname(directory);
      }
    }
  }

  authorityPaths(): readonly string[] {
    return [...this.#observations.values()].filter(({ kind }) => kind === "package-authority")
      .map(({ path }) => path).toSorted(compareBinaryStrings);
  }

  typeScopes(): readonly { readonly rootPath: string; readonly moduleType: "module" | "commonjs" }[] {
    return [...this.#observations.values()].flatMap(({ path, moduleType }) =>
      moduleType === undefined ? [] : [{ rootPath: posix.dirname(path), moduleType }]
    ).toSorted((a, b) => compareBinaryStrings(a.rootPath, b.rootPath));
  }

  deriveOwnership(governedRoots: readonly string[], includeRoot: boolean): SourcePackageOwnership {
    const ownershipManifestPaths = this.authorityPaths();
    const candidates = ownershipManifestPaths.map((manifestPath) => ({ manifestPath, rootPath: posix.dirname(manifestPath) }));
    const rootSourceRoots = governedRoots.filter((path) =>
      sourcePackageOwner(path, candidates, { ownershipManifestPaths, rootSourceRoots: governedRoots })?.rootPath === "."
    ).toSorted(compareBinaryStrings);
    return { ownershipManifestPaths, rootSourceRoots: includeRoot ? rootSourceRoots : [] };
  }

  async revalidate(): Promise<void> {
    for (const observation of this.#observations.values()) {
      assertActive(this.#signal);
      await revalidateStableRepositoryPath(this.#root, observation.parent, this.#files, this.#signal);
      if (observation.captured === undefined) {
        try {
          await this.#files.lstat(join(this.#root, observation.path));
        } catch (error) {
          assertActive(this.#signal);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { continue; }
        }
        inputError("SOURCE_FILESYSTEM_CHANGED", `Previously absent manifest changed: ${observation.path}.`);
      }
      await revalidateStableRepositoryPath(this.#root, observation.captured, this.#files, this.#signal);
      const bytes = await this.#read(observation.path);
      if (!Buffer.from(bytes).equals(Buffer.from(observation.bytes ?? []))) {
        inputError("SOURCE_FILESYSTEM_CHANGED", `Package manifest bytes changed: ${observation.path}.`);
      }
      await revalidateStableRepositoryPath(this.#root, observation.captured, this.#files, this.#signal);
    }
  }
}
