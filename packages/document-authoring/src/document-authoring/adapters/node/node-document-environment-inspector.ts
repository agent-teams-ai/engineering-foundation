import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  DocumentEnvironmentInspection,
  DocumentEnvironmentInspector
} from "../../application/ports/document-environment-inspector.js";

interface Dependencies {
  readonly buildIdentity: () => Promise<string>;
  readonly lstat: typeof lstat;
  readonly platform: NodeJS.Platform;
  readonly realpath: typeof realpath;
  readonly version: () => Promise<string>;
}

type EnvironmentIdentityProviders = Pick<Dependencies, "buildIdentity" | "version">;

const nodeFilesystemDependencies: Omit<Dependencies, "buildIdentity" | "version"> = {
  lstat,
  platform: process.platform,
  realpath
};

export class NodeDocumentEnvironmentInspector implements DocumentEnvironmentInspector {
  readonly #dependencies: Dependencies;

  constructor(
    identity: EnvironmentIdentityProviders,
    filesystem: Partial<Omit<Dependencies, "buildIdentity" | "version">> = {}
  ) {
    this.#dependencies = {
      ...nodeFilesystemDependencies,
      ...filesystem,
      ...identity
    };
  }

  async inspect(
    consumerRoot: string,
    signal?: AbortSignal
  ): Promise<DocumentEnvironmentInspection> {
    signal?.throwIfAborted();
    const requestedRoot = resolve(consumerRoot);
    const [metadata, canonicalRoot, installedVersion, installedBuildIdentity] =
      await Promise.all([
        this.#dependencies.lstat(requestedRoot),
        this.#dependencies.realpath(requestedRoot),
        this.#dependencies.version(),
        this.#dependencies.buildIdentity()
      ]);
    signal?.throwIfAborted();
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory()
    ) {
      throw new Error(
        "Document doctor consumer root must be a canonical real directory."
      );
    }
    const canonicalMetadata = await this.#dependencies.lstat(canonicalRoot);
    if (
      canonicalMetadata.isSymbolicLink() ||
      !canonicalMetadata.isDirectory()
    ) {
      throw new Error(
        "Document doctor consumer root must resolve to a real directory."
      );
    }
    signal?.throwIfAborted();
    return Object.freeze({
      installedFoundationVersion: installedVersion,
      installedFoundationBuildIdentity: installedBuildIdentity,
      filesystem: Object.freeze({
        basis: "platform-contract" as const,
        strictDirectoryDurability:
          this.#dependencies.platform === "win32"
            ? "platform-unsupported" as const
            : "platform-supported" as const
      })
    });
  }
}
