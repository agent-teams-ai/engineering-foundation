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
import type { DocumentOwnedTemporary } from "../../application/model/document-transaction.js";
import type { DocumentPlan } from "../../application/model/document-planning.js";
import type { DocumentPublisher } from "../../application/ports/document-publisher.js";
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

function wireIdentity(identity: PortablePathIdentity): DocumentOwnedTemporary["identity"] {
  return {
    adapter: "node-filesystem",
    version: 1,
    dev: identity.dev.toString(10),
    ino: identity.ino.toString(10),
    birthtimeNs: identity.birthtimeNs.toString(10)
  };
}

function physicalIdentity(temporary: DocumentOwnedTemporary): PortablePathIdentity {
  const decimal = /^(?:0|[1-9][0-9]{0,31})$/u;
  const value = temporary.identity;
  if (value.adapter !== "node-filesystem" || value.version !== 1 ||
    ![value.dev, value.ino, value.birthtimeNs].every((part) => decimal.test(part))) {
    throw new Error("Document temporary physical identity is invalid.");
  }
  const result = {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    birthtimeNs: BigInt(value.birthtimeNs)
  };
  if (result.dev === 0n || result.ino === 0n || result.birthtimeNs === 0n) {
    throw new Error("Document temporary has zero physical identity and cannot authorize mutation.");
  }
  return result;
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
  }): Promise<DocumentOwnedTemporary> {
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
    const captured = await prepareExactSiblingTemporary({
      displayPath: temporaryPath,
      faultInjector: undefined,
      onIdentityCaptured() {},
      open,
      postimage: postimage(request.plan),
      temporaryPath: temporaryAbsolutePath
    });
    await requireDirectoryDurability(recaptured.parent);
    physicalIdentity({
      path: temporaryPath,
      digest: request.plan.output.digest,
      identity: wireIdentity(captured)
    });
    return Object.freeze({
      path: temporaryPath,
      digest: request.plan.output.digest,
      identity: Object.freeze(wireIdentity(captured))
    });
  }

  async publishPrepared(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<"already-satisfied" | "published"> {
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
    return publishPreparedAbsentFile({
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
  }

  async removeOwnedTemporary(request: {
    readonly consumerRoot: string;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<void> {
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
