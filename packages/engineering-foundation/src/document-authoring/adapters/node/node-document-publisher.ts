import { createHash } from "node:crypto";
import { link, open, rm } from "node:fs/promises";

import {
  cleanupIdentityMatchingOwnedTemporary,
  pathMatchesRegularFileIdentity,
  prepareExactSiblingTemporary,
  publishPreparedAbsentFile,
  readBoundedRegularFile,
  syncDirectoryDurably,
  syncDirectoryStrictly
} from "@agent-teams/repository-mutation";
import type { PortablePathIdentity } from "@agent-teams/repository-mutation";
import {
  assertDocumentPhysicalIdentity,
  assertNonzeroDocumentPhysicalIdentity,
  type DocumentPhysicalIdentity
} from "../../application/model/document-physical-identity.js";
import type { DocumentOwnedTemporary } from "../../application/model/document-transaction.js";
import type { DocumentPlanContract as DocumentPlan } from "../../application/model/document-planning.js";
import type {
  DocumentPublicationResult,
  DocumentPublisher
} from "../../application/ports/document-publisher.js";
import { documentTemporaryPath } from "../../application/policies/document-temporary-path.js";
import {
  recaptureDocumentPublicationPaths,
  sameDocumentAncestry,
  sameDocumentPhysicalIdentity
} from "./recapture-document-publication-paths.js";

function postimage(plan: DocumentPlan) {
  return {
    bytes: Buffer.from(plan.output.contentBase64, "base64"),
    digest: plan.output.digest,
    mode: 0o644,
    size: plan.output.size
  };
}

function wireIdentity(
  identity: PortablePathIdentity,
  authorityRequired: boolean
): DocumentPhysicalIdentity {
  const result: DocumentPhysicalIdentity = {
    adapter: "node-filesystem",
    version: 1,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
    birthtimeNs: identity.birthtimeNs.toString(10)
  };
  assertDocumentPhysicalIdentity(result);
  if (authorityRequired) {
    assertNonzeroDocumentPhysicalIdentity(result);
  }
  return result;
}

function physicalIdentity(temporary: DocumentOwnedTemporary): PortablePathIdentity {
  const value = temporary.identity;
  assertNonzeroDocumentPhysicalIdentity(value);
  const result = {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    birthtimeNs: BigInt(value.birthtimeNs)
  };
  return result;
}

async function readExactPublicationIdentity(
  destinationPath: string,
  plan: DocumentPlan
): Promise<DocumentPhysicalIdentity> {
  const observed = await readBoundedRegularFile(destinationPath, plan.output.size);
  if (observed.outcome !== "read" ||
    observed.bytes.byteLength !== plan.output.size ||
    `sha256:${createHash("sha256").update(observed.bytes).digest("hex")}` !== plan.output.digest ||
    (process.platform !== "win32" && (observed.mode & 0o777) !== 0o644)) {
    throw new Error("Published document identity could not be verified.");
  }
  return wireIdentity(observed.identity, true);
}

function assertTemporaryBinding(plan: DocumentPlan, temporary: DocumentOwnedTemporary): void {
  if (temporary.path !== documentTemporaryPath(plan.destination, plan.planDigest) ||
    temporary.digest !== plan.output.digest) {
    throw new Error("Document temporary is not exactly bound to the supplied Plan.");
  }
}

type NodeDocumentPublisherFaultPoint =
  | { readonly phase: "after-temporary-synced" }
  | { readonly phase: "after-hard-link" }
  | { readonly phase: "after-publication-synced" }
  | { readonly phase: "after-temporary-cleanup-synced" };

type NodeDocumentPublisherFaultInjector = (
  point: NodeDocumentPublisherFaultPoint
) => Promise<void> | void;

export interface NodeDocumentPublisherOperations {
  readonly faultInjector?: NodeDocumentPublisherFaultInjector;
  readonly link?: typeof link;
  readonly open?: typeof open;
  readonly remove?: typeof rm;
  readonly syncDirectoryDurably?: typeof syncDirectoryDurably;
  readonly syncDirectoryStrictly?: typeof syncDirectoryStrictly;
}

export class NodeDocumentPublisher implements DocumentPublisher {
  readonly #operations: Required<Omit<NodeDocumentPublisherOperations, "faultInjector">> &
    Pick<NodeDocumentPublisherOperations, "faultInjector">;

  public constructor(operations: NodeDocumentPublisherOperations = {}) {
    this.#operations = {
      link: operations.link ?? link,
      open: operations.open ?? open,
      remove: operations.remove ?? rm,
      syncDirectoryDurably: operations.syncDirectoryDurably ?? syncDirectoryDurably,
      syncDirectoryStrictly: operations.syncDirectoryStrictly ?? syncDirectoryStrictly,
      ...(operations.faultInjector === undefined
        ? {}
        : { faultInjector: operations.faultInjector })
    };
  }

  async prepare(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentOwnedTemporary> {
    request.signal?.throwIfAborted();
    const paths = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    const temporaryPath = documentTemporaryPath(
      request.plan.destination,
      request.plan.planDigest
    );
    const temporaryBefore = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: temporaryPath
    });
    if (!sameDocumentAncestry(
      paths.ancestryIdentities,
      temporaryBefore.ancestryIdentities
    )) {
      throw new Error("Document temporary is not confined to the publication parent.");
    }
    await this.#operations.syncDirectoryStrictly(paths.parent);
    const recaptured = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    if (!sameDocumentAncestry(paths.ancestryIdentities, recaptured.ancestryIdentities)) {
      throw new Error("Document publication parent changed during durability preflight.");
    }
    request.signal?.throwIfAborted();
    const captured = await prepareExactSiblingTemporary({
      displayPath: temporaryPath,
      onIdentityCaptured() {},
      open: this.#operations.open,
      postimage: postimage(request.plan),
      temporaryPath: temporaryBefore.destinationPath,
      async validateOpenedPath(identity) {
        const openedAuthority = await recaptureDocumentPublicationPaths({
          consumerRoot: request.consumerRoot,
          destination: temporaryPath
        });
        if (!sameDocumentAncestry(
          temporaryBefore.ancestryIdentities,
          openedAuthority.ancestryIdentities
        ) || (await pathMatchesRegularFileIdentity(
          openedAuthority.destinationPath,
          identity
        )) !== "match") {
          throw new Error(
            "Opened document temporary is not bound to the captured repository ancestry."
          );
        }
      }
    });
    const temporaryAfterOpen = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: temporaryPath
    });
    if (!sameDocumentAncestry(
      temporaryBefore.ancestryIdentities,
      temporaryAfterOpen.ancestryIdentities
    )) {
      throw new Error("Document temporary parent changed while the file was prepared.");
    }
    const observedTemporary = await readBoundedRegularFile(
      temporaryAfterOpen.destinationPath,
      request.plan.output.size
    );
    if (observedTemporary.outcome !== "read" ||
      !sameDocumentPhysicalIdentity(observedTemporary.identity, captured)) {
      throw new Error("Prepared document handle is no longer bound to its repository path.");
    }
    const temporaryAfterRead = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: temporaryPath
    });
    if (!sameDocumentAncestry(
      temporaryAfterOpen.ancestryIdentities,
      temporaryAfterRead.ancestryIdentities
    )) {
      throw new Error("Document temporary parent changed during post-open verification.");
    }
    await this.#operations.syncDirectoryStrictly(temporaryAfterRead.parent);
    await this.#operations.faultInjector?.({ phase: "after-temporary-synced" });
    const finalPaths = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: temporaryPath
    });
    if (!sameDocumentAncestry(
      temporaryAfterRead.ancestryIdentities,
      finalPaths.ancestryIdentities
    )) {
      throw new Error("Document temporary parent changed before identity binding.");
    }
    const temporary: DocumentOwnedTemporary = {
      path: temporaryPath,
      digest: request.plan.output.digest,
      identity: wireIdentity(captured, true)
    };
    return Object.freeze({
      ...temporary,
      identity: Object.freeze(temporary.identity)
    });
  }

  async publishPrepared(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<DocumentPublicationResult> {
    request.signal?.throwIfAborted();
    assertTemporaryBinding(request.plan, request.temporary);
    const expectedIdentity = physicalIdentity(request.temporary);
    const before = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    await this.#operations.syncDirectoryStrictly(before.parent);
    const paths = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    if (!sameDocumentAncestry(before.ancestryIdentities, paths.ancestryIdentities)) {
      throw new Error("Document publication parent changed during durability preflight.");
    }
    const temporaryAuthority = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.temporary.path
    });
    if (!sameDocumentAncestry(
      paths.ancestryIdentities,
      temporaryAuthority.ancestryIdentities
    )) {
      throw new Error("Bound document temporary left the publication parent.");
    }
    const temporaryPath = temporaryAuthority.destinationPath;
    request.signal?.throwIfAborted();
    // No cancellation observation is allowed after this point: link may have
    // succeeded even when a caller aborts while publication is in flight.
    const outcome = await publishPreparedAbsentFile({
      allowUnsupportedDirectoryDurability: false,
      classifyBoundedRegularFile: readBoundedRegularFile,
      destinationPath: paths.destinationPath,
      displayPath: request.plan.destination,
      expectedIdentity,
      link: async (source, destination) => {
        const immediatelyBefore = await recaptureDocumentPublicationPaths({
          consumerRoot: request.consumerRoot,
          destination: request.plan.destination
        });
        const sourceBefore = await recaptureDocumentPublicationPaths({
          consumerRoot: request.consumerRoot,
          destination: request.temporary.path
        });
        if (!sameDocumentAncestry(
          paths.ancestryIdentities,
          immediatelyBefore.ancestryIdentities
        ) || !sameDocumentAncestry(
          immediatelyBefore.ancestryIdentities,
          sourceBefore.ancestryIdentities
        )) {
          throw new Error("Document publication ancestry changed before link.");
        }
        await this.#operations.link(source, destination);
        await this.#operations.faultInjector?.({ phase: "after-hard-link" });
        const immediatelyAfter = await recaptureDocumentPublicationPaths({
          consumerRoot: request.consumerRoot,
          destination: request.plan.destination
        });
        if (!sameDocumentAncestry(
          immediatelyBefore.ancestryIdentities,
          immediatelyAfter.ancestryIdentities
        )) {
          throw new Error("Document publication ancestry changed during link.");
        }
      },
      parent: paths.parent,
      postimage: postimage(request.plan),
      readBoundedRegularFile,
      syncDirectory: this.#operations.syncDirectoryDurably,
      temporaryPath
    });
    const afterPublication = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    if (!sameDocumentAncestry(
      paths.ancestryIdentities,
      afterPublication.ancestryIdentities
    )) {
      throw new Error("Document publication ancestry changed during link.");
    }
    await this.#operations.faultInjector?.({ phase: "after-publication-synced" });
    const finalPublication = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    if (!sameDocumentAncestry(
      afterPublication.ancestryIdentities,
      finalPublication.ancestryIdentities
    )) {
      throw new Error("Document publication ancestry changed before completion.");
    }
    if (outcome === "published") {
      return Object.freeze({
        outcome,
        publicationIdentity: Object.freeze(wireIdentity(expectedIdentity, true)),
        identityEvidence: "owned-temporary"
      });
    }
    return Object.freeze({
      outcome,
      publicationIdentity: Object.freeze(
        await readExactPublicationIdentity(
          finalPublication.destinationPath,
          request.plan
        )
      )
    });
  }

  async completePublication(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<{ readonly publicationIdentity: DocumentPhysicalIdentity }> {
    request.signal?.throwIfAborted();
    assertTemporaryBinding(request.plan, request.temporary);
    const expectedIdentity = physicalIdentity(request.temporary);
    const before = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    const temporaryAuthority = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.temporary.path
    });
    if (!sameDocumentAncestry(
      before.ancestryIdentities,
      temporaryAuthority.ancestryIdentities
    )) {
      throw new Error("Bound document temporary left the publication parent.");
    }
    const temporaryPath = temporaryAuthority.destinationPath;
    request.signal?.throwIfAborted();
    // From this point recovery completion is cancellation-masked: publication
    // may already exist and its durability must reach a verified postcondition.
    const publicationIdentity = await readExactPublicationIdentity(
      before.destinationPath,
      request.plan
    );
    if (!sameDocumentPhysicalIdentity(
      {
        dev: BigInt(publicationIdentity.dev),
        ino: BigInt(publicationIdentity.ino),
        birthtimeNs: BigInt(publicationIdentity.birthtimeNs)
      },
      expectedIdentity
    )) {
      throw new Error("Published document does not match its bound temporary identity.");
    }
    try {
      const observedTemporary = await readBoundedRegularFile(
        temporaryPath,
        request.plan.output.size
      );
      if (observedTemporary.outcome !== "read" ||
        !sameDocumentPhysicalIdentity(observedTemporary.identity, expectedIdentity) ||
        `sha256:${createHash("sha256").update(observedTemporary.bytes).digest("hex")}` !== request.plan.output.digest ||
        (process.platform !== "win32" && (observedTemporary.mode & 0o777) !== 0o644)) {
        throw new Error("Bound document temporary changed during publication completion.");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw error;
      }
    }
    await this.#operations.syncDirectoryStrictly(before.parent);
    const after = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    if (!sameDocumentAncestry(before.ancestryIdentities, after.ancestryIdentities)) {
      throw new Error("Document publication parent changed during completion.");
    }
    const verifiedIdentity = await readExactPublicationIdentity(
      after.destinationPath,
      request.plan
    );
    if (verifiedIdentity.dev !== publicationIdentity.dev ||
      verifiedIdentity.ino !== publicationIdentity.ino ||
      verifiedIdentity.birthtimeNs !== publicationIdentity.birthtimeNs) {
      throw new Error("Published document identity changed during completion.");
    }
    return Object.freeze({
      publicationIdentity: Object.freeze(verifiedIdentity)
    });
  }

  async removeOwnedTemporary(request: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<void> {
    request.signal?.throwIfAborted();
    const expectedIdentity = physicalIdentity(request.temporary);
    const paths = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.temporary.path
    });
    await this.#operations.syncDirectoryStrictly(paths.parent);
    const recaptured = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.temporary.path
    });
    if (!sameDocumentAncestry(paths.ancestryIdentities, recaptured.ancestryIdentities)) {
      throw new Error("Document temporary parent changed during durability preflight.");
    }
    request.signal?.throwIfAborted();
    // Cleanup is an identity-authorized mutation. Once started, finish without
    // observing cancellation so callers cannot receive a false pre-mutation view.
    const outcome = await cleanupIdentityMatchingOwnedTemporary({
      allowUnsupportedDirectoryDurability: false,
      displayPath: request.temporary.path,
      expectedIdentity,
      parent: recaptured.parent,
      rm: this.#operations.remove,
      syncDirectory: this.#operations.syncDirectoryDurably,
      temporaryPath: recaptured.destinationPath
    });
    if (outcome === "different") {
      throw new Error("Document temporary was replaced and was preserved.");
    }
    await this.#operations.faultInjector?.({
      phase: "after-temporary-cleanup-synced"
    });
    const final = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.temporary.path
    });
    if (!sameDocumentAncestry(
      recaptured.ancestryIdentities,
      final.ancestryIdentities
    )) {
      throw new Error("Document temporary ancestry changed during cleanup.");
    }
  }
}
