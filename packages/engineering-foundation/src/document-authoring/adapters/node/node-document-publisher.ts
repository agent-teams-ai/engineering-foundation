import { createHash } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { cleanupIdentityMatchingOwnedTemporary } from "../../../repository-mutation/adapters/node/node-cleanup-owned-temporary.js";
import {
  syncDirectoryDurably,
  syncDirectoryStrictly
} from "../../../repository-mutation/adapters/node/node-directory-durability.js";
import { prepareExactSiblingTemporary } from "../../../repository-mutation/adapters/node/node-prepare-exact-sibling-temporary.js";
import { publishPreparedAbsentFile } from "../../../repository-mutation/adapters/node/node-publish-prepared-absent-file.js";
import { readBoundedRegularFile } from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";
import {
  assertDocumentPhysicalIdentity,
  assertNonzeroDocumentPhysicalIdentity,
  type DocumentPhysicalIdentity
} from "../../application/model/document-physical-identity.js";
import type { DocumentOwnedTemporary } from "../../application/model/document-transaction.js";
import type { DocumentPlan } from "../../application/model/document-planning.js";
import type {
  DocumentPublicationResult,
  DocumentPublisher
} from "../../application/ports/document-publisher.js";
import { documentTemporaryPath } from "../../application/policies/document-temporary-path.js";
import {
  recaptureDocumentPublicationPaths,
  sameDocumentAncestry
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

async function requireDirectoryDurability(parent: string): Promise<void> {
  await syncDirectoryStrictly(parent);
}

function assertTemporaryBinding(plan: DocumentPlan, temporary: DocumentOwnedTemporary): void {
  if (temporary.path !== documentTemporaryPath(plan.destination, plan.planDigest) ||
    temporary.digest !== plan.output.digest) {
    throw new Error("Document temporary is not exactly bound to the supplied Plan.");
  }
}

export class NodeDocumentPublisher implements DocumentPublisher {
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
    const temporaryAbsolutePath = join(paths.root, ...temporaryPath.split("/"));
    await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: temporaryPath
    });
    await requireDirectoryDurability(paths.parent);
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
      faultInjector: undefined,
      onIdentityCaptured() {},
      open,
      postimage: postimage(request.plan),
      temporaryPath: temporaryAbsolutePath
    });
    await requireDirectoryDurability(recaptured.parent);
    const temporary: DocumentOwnedTemporary = {
      path: temporaryPath,
      digest: request.plan.output.digest,
      identity: wireIdentity(captured, false)
    };
    physicalIdentity(temporary);
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
    await requireDirectoryDurability(before.parent);
    const paths = await recaptureDocumentPublicationPaths({
      consumerRoot: request.consumerRoot,
      destination: request.plan.destination
    });
    if (!sameDocumentAncestry(before.ancestryIdentities, paths.ancestryIdentities)) {
      throw new Error("Document publication parent changed during durability preflight.");
    }
    const temporaryPath = join(paths.root, ...request.temporary.path.split("/"));
    request.signal?.throwIfAborted();
    // No cancellation observation is allowed after this point: link may have
    // succeeded even when a caller aborts while publication is in flight.
    const outcome = await publishPreparedAbsentFile({
      allowUnsupportedDirectoryDurability: false,
      classifyBoundedRegularFile: readBoundedRegularFile,
      destinationPath: paths.destinationPath,
      displayPath: request.plan.destination,
      expectedIdentity,
      faultInjector: undefined,
      link,
      parent: paths.parent,
      postimage: postimage(request.plan),
      readBoundedRegularFile,
      syncDirectory: syncDirectoryDurably,
      temporaryPath
    });
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
        await readExactPublicationIdentity(paths.destinationPath, request.plan)
      )
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
    await requireDirectoryDurability(paths.parent);
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
      rm,
      syncDirectory: syncDirectoryDurably,
      temporaryPath: recaptured.destinationPath
    });
    if (outcome === "different") {
      throw new Error("Document temporary was replaced and was preserved.");
    }
  }
}
