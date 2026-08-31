import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  createAndBindNodeDirectory,
  syncDirectoryStrictly
} from "@agent-teams/repository-mutation";
import {
  assertNonzeroDocumentPhysicalIdentity,
  type DocumentPhysicalIdentity
} from "../../application/model/document-physical-identity.js";
import type {
  DocumentCreatedDirectoryEvidenceV2,
  DocumentParentMaterializationInspectionV2,
  DocumentParentMaterializationJournalV2,
  DocumentParentMaterializationPlanV2
} from "../../application/model/document-parent-materialization.js";
import { isDocumentRepositoryPath } from "../../application/policies/document-repository-path.js";
import {
  captureNodeRepositoryDirectoryAuthority,
  captureNodeRepositoryPathAuthority,
  captureNodeRepositoryRootAuthority,
  sameNodePathAncestry,
  sameNodePathIdentity,
  type NodePathAuthorityOperations
} from "./node-path-authority.js";

interface Operations extends NodePathAuthorityOperations {
  // Node's mkdir does not return a descriptor or creation identity. The
  // production adapter returns the first observable post-mkdir identity. It is
  // authoritative only under the cooperative-writer threat contract described
  // by node-path-authority; a hostile replacement inside mkdir -> lstat is not
  // distinguishable with the portable Node API.
  readonly mkdir: (
    path: string,
    options: { readonly mode: number }
  ) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
}

const nodeOperations: Operations = {
  lstat: (path) => lstat(path, { bigint: true }),
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  readdir,
  realpath,
  syncDirectory: syncDirectoryStrictly
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function documentIdentity(identity: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): DocumentPhysicalIdentity {
  const result = {
    adapter: "node-filesystem" as const,
    version: 1 as const,
    birthtimeNs: identity.birthtimeNs.toString(10),
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10)
  };
  assertNonzeroDocumentPhysicalIdentity(result);
  return Object.freeze(result);
}

function portableIdentity(identity: DocumentPhysicalIdentity) {
  assertNonzeroDocumentPhysicalIdentity(identity);
  return {
    birthtimeNs: BigInt(identity.birthtimeNs),
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino)
  };
}

function assertClosedPlan(plan: DocumentParentMaterializationPlanV2): void {
  if ((plan as { readonly policy?: unknown }).policy !==
      "create-missing-real-directories" ||
    (plan.deepestExistingDirectory !== "." &&
      !isDocumentRepositoryPath(plan.deepestExistingDirectory)) ||
    (plan.finalParent !== "." && !isDocumentRepositoryPath(plan.finalParent))) {
    throw new TypeError("Document parent materialization Plan is invalid.");
  }
  const expected: string[] = [];
  let current = plan.deepestExistingDirectory;
  const anchorSegments = current === "." ? [] : current.split("/");
  const finalSegments = plan.finalParent === "." ? [] : plan.finalParent.split("/");
  if (anchorSegments.length > finalSegments.length ||
    anchorSegments.some((segment, index) => segment !== finalSegments[index])) {
    throw new TypeError("Materialization anchor is not an ancestor of the final parent.");
  }
  for (const segment of finalSegments.slice(anchorSegments.length)) {
    current = current === "." ? segment : `${current}/${segment}`;
    expected.push(current);
  }
  if (expected.length !== plan.missingDirectories.length ||
    expected.some((path, index) => path !== plan.missingDirectories[index])) {
    throw new TypeError("Materialization missing directories are not one exact parent chain.");
  }
}

export async function planDocumentParentMaterializationV2(request: {
  readonly consumerRoot: string;
  readonly destination: string;
  readonly signal?: AbortSignal;
}): Promise<DocumentParentMaterializationPlanV2> {
  request.signal?.throwIfAborted();
  if (!isDocumentRepositoryPath(request.destination)) {
    throw new TypeError("Document destination is not a portable repository path.");
  }
  await captureNodeRepositoryRootAuthority(request.consumerRoot, nodeOperations);
  const parentSegments = request.destination.split("/").slice(0, -1);
  let deepestExistingDirectory = ".";
  let firstMissing = parentSegments.length;
  for (let index = 0; index < parentSegments.length; index += 1) {
    request.signal?.throwIfAborted();
    const repositoryPath = parentSegments.slice(0, index + 1).join("/");
    try {
      await captureNodeRepositoryDirectoryAuthority({
        consumerRoot: request.consumerRoot,
        operations: nodeOperations,
        repositoryPath
      });
    } catch (error) {
      if (isMissing(error)) {
        firstMissing = index;
        break;
      }
      throw error;
    }
    deepestExistingDirectory = repositoryPath;
  }
  const missingDirectories = Object.freeze(
    parentSegments.slice(firstMissing).map((_segment, offset) =>
      parentSegments.slice(0, firstMissing + offset + 1).join("/"))
  );
  const finalParent = parentSegments.length === 0 ? "." : parentSegments.join("/");
  const plan = Object.freeze({
    deepestExistingDirectory,
    finalParent,
    missingDirectories,
    policy: "create-missing-real-directories" as const
  });
  assertClosedPlan(plan);
  return plan;
}

export class NodeDocumentParentMaterializerV2 {
  readonly #operations: Operations;

  constructor(overrides: Partial<Operations> = {}) {
    this.#operations = { ...nodeOperations, ...overrides };
  }

  async begin(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentParentMaterializationPlanV2;
  }): Promise<DocumentParentMaterializationJournalV2> {
    assertClosedPlan(request.plan);
    const anchor = await captureNodeRepositoryDirectoryAuthority({
      consumerRoot: request.consumerRoot,
      operations: this.#operations,
      repositoryPath: request.plan.deepestExistingDirectory
    });
    return Object.freeze({
      anchorIdentity: documentIdentity(anchor.directoryIdentity),
      createdDirectories: Object.freeze([]),
      plan: request.plan,
      schemaVersion: 2 as const
    });
  }

  async inspect(request: {
    readonly consumerRoot: string;
    readonly journal: DocumentParentMaterializationJournalV2;
  }): Promise<DocumentParentMaterializationInspectionV2> {
    const { journal } = request;
    assertClosedPlan(journal.plan);
    assertNonzeroDocumentPhysicalIdentity(journal.anchorIdentity);
    if (journal.createdDirectories.length > journal.plan.missingDirectories.length ||
      journal.createdDirectories.some((entry, index) =>
        entry.path !== journal.plan.missingDirectories[index])) {
      throw new TypeError("Created directory evidence must be an exact Plan prefix.");
    }
    const createdByPath = new Map(journal.createdDirectories.map((entry) => [entry.path, entry]));
    let anchor;
    try {
      anchor = await captureNodeRepositoryDirectoryAuthority({
        consumerRoot: request.consumerRoot,
        operations: this.#operations,
        repositoryPath: journal.plan.deepestExistingDirectory
      });
    } catch {
      return { path: journal.plan.deepestExistingDirectory, reason: "anchor-changed", state: "manual-recovery-required" };
    }
    if (!sameNodePathIdentity(
      anchor.directoryIdentity,
      portableIdentity(journal.anchorIdentity)
    )) {
      return { path: journal.plan.deepestExistingDirectory, reason: "anchor-changed", state: "manual-recovery-required" };
    }
    for (const path of journal.plan.missingDirectories) {
      const expected = createdByPath.get(path);
      let captured;
      try {
        captured = await captureNodeRepositoryDirectoryAuthority({
          consumerRoot: request.consumerRoot,
          operations: this.#operations,
          repositoryPath: path
        });
      } catch (error) {
        if (isMissing(error)) {
          if (expected !== undefined) {
            return { path, reason: "created-directory-changed", state: "manual-recovery-required" };
          }
          return { nextDirectory: path, state: "current" };
        }
        if (expected !== undefined) {
          return { path, reason: "created-directory-changed", state: "manual-recovery-required" };
        }
        return {
          path,
          reason: error instanceof Error &&
              /portable name collision/u.test(error.message)
            ? "portable-name-collision"
            : "unbound-directory-exists",
          state: "manual-recovery-required"
        };
      }
      if (expected === undefined) {
        return { path, reason: "unbound-directory-exists", state: "manual-recovery-required" };
      }
      if (!sameNodePathIdentity(
        captured.directoryIdentity,
        portableIdentity(expected.identity)
      )) {
        return { path, reason: "created-directory-changed", state: "manual-recovery-required" };
      }
    }
    return { state: "current" };
  }

  async createNext(request: {
    readonly consumerRoot: string;
    readonly journal: DocumentParentMaterializationJournalV2;
    readonly signal?: AbortSignal;
  }): Promise<DocumentCreatedDirectoryEvidenceV2 | undefined> {
    request.signal?.throwIfAborted();
    const inspection = await this.inspect(request);
    if (inspection.state !== "current") {
      throw new Error(`Document parent materialization requires manual recovery: ${inspection.reason}.`);
    }
    if (inspection.nextDirectory === undefined) {
      return undefined;
    }
    const path = inspection.nextDirectory;
    const targetAuthority = await captureNodeRepositoryPathAuthority({
      consumerRoot: request.consumerRoot,
      operations: this.#operations,
      repositoryPath: path
    });
    const basename = path.split("/").at(-1)!;
    request.signal?.throwIfAborted();
    const absolute = join(targetAuthority.parent, basename);
    await this.#operations.mkdir(
      absolute,
      { mode: 0o755 }
    );
    const firstObservedAfterMkdir = await this.#operations.lstat(absolute);
    // No cancellation observation after mkdir: the returned identity must be
    // durably journaled by the caller before another directory is created.
    const createdIdentity = portableIdentity(
      documentIdentity(firstObservedAfterMkdir)
    );
    const captured = await captureNodeRepositoryDirectoryAuthority({
      consumerRoot: request.consumerRoot,
      operations: this.#operations,
      repositoryPath: path
    });
    if (!sameNodePathIdentity(createdIdentity, captured.directoryIdentity) ||
      !sameNodePathAncestry(
        targetAuthority.ancestry,
        captured.ancestry.slice(0, -1)
      )) {
      throw new Error(
        "Created document directory changed before its identity could be bound. Manual recovery is required."
      );
    }
    await this.#operations.syncDirectory(targetAuthority.parent);
    const finalCapture = await captureNodeRepositoryDirectoryAuthority({
      consumerRoot: request.consumerRoot,
      operations: this.#operations,
      repositoryPath: path
    });
    if (!sameNodePathIdentity(createdIdentity, finalCapture.directoryIdentity) ||
      !sameNodePathAncestry(captured.ancestry, finalCapture.ancestry)) {
      throw new Error(
        "Created document directory changed before its durable identity binding. Manual recovery is required."
      );
    }
    return Object.freeze({ path, identity: documentIdentity(createdIdentity) });
  }

  async createAndBindOne(request: {
    readonly consumerRoot: string;
    readonly expectedParentIdentity: DocumentPhysicalIdentity;
    readonly path: string;
    readonly bindCreatedDirectory: (
      evidence: DocumentCreatedDirectoryEvidenceV2
    ) => Promise<void>;
  }): Promise<void> {
    const operations = this.#operations;
    await createAndBindNodeDirectory({
      ambiguousError: (error) => new Error(
        `Document directory creation is ambiguous and requires manual recovery: ${request.path}.`,
        { cause: error }
      ),
      bind: request.bindCreatedDirectory,
      async captureParent() {
        const target = await captureNodeRepositoryPathAuthority({
          consumerRoot: request.consumerRoot,
          operations,
          repositoryPath: request.path
        });
        if (!sameNodePathIdentity(
          target.parentIdentity,
          portableIdentity(request.expectedParentIdentity)
        )) {
          throw new Error("Document materialization parent identity changed.");
        }
        return target;
      },
      async createAndObserve(target, markCreated) {
        await operations.mkdir(target.destinationPath, { mode: 0o755 });
        markCreated();
        return portableIdentity(documentIdentity(
          await operations.lstat(target.destinationPath)
        ));
      },
      async recapture(target, observed) {
        const captured = await captureNodeRepositoryDirectoryAuthority({
          consumerRoot: request.consumerRoot,
          operations,
          repositoryPath: request.path
        });
        if (!sameNodePathIdentity(observed, captured.directoryIdentity) ||
          !sameNodePathAncestry(
            target.ancestry,
            captured.ancestry.slice(0, -1)
          )) {
          throw new Error("Created directory or its ancestry changed before binding.");
        }
        return Object.freeze({
          identity: documentIdentity(captured.directoryIdentity),
          path: request.path
        });
      },
      async syncParent(target) {
        await operations.syncDirectory(target.parent);
      }
    });
  }

}
