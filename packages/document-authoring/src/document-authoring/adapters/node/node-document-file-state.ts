import { createHash } from "node:crypto";

import { readBoundedRegularFile } from "@agent-teams/repository-mutation/node";
import type { PortablePathIdentity } from "@agent-teams/repository-mutation/paths";
import {
  assertNonzeroDocumentPhysicalIdentity,
  type DocumentPhysicalIdentity
} from "../../application/model/document-physical-identity.js";
import type { DocumentOwnedTemporary } from "../../application/model/document-transaction.js";
import type { DocumentPlanContract as DocumentPlan } from "../../application/model/document-planning.js";
import type {
  DocumentDerivedTemporaryState,
  DocumentDestinationState,
  DocumentFileState,
  DocumentTemporaryState
} from "../../application/ports/document-file-state.js";
import { isDocumentRepositoryPath } from "../../application/policies/document-repository-path.js";
import { documentTemporaryPath } from "../../application/policies/document-temporary-path.js";
import {
  recaptureDocumentPublicationPaths,
  sameDocumentAncestry,
  sameDocumentPhysicalIdentity
} from "./recapture-document-publication-paths.js";

const MAXIMUM_DOCUMENT_BYTES = 1_048_576;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function identity(temporary: DocumentOwnedTemporary): PortablePathIdentity | undefined {
  const value = temporary.identity;
  try {
    assertNonzeroDocumentPhysicalIdentity(value);
  } catch {
    return undefined;
  }
  const result = {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    birthtimeNs: BigInt(value.birthtimeNs)
  };
  return result;
}

function wireIdentity(identityValue: PortablePathIdentity): DocumentPhysicalIdentity {
  const result: DocumentPhysicalIdentity = {
    adapter: "node-filesystem",
    version: 1,
    dev: identityValue.dev.toString(10),
    ino: identityValue.ino.toString(10),
    birthtimeNs: identityValue.birthtimeNs.toString(10)
  };
  assertNonzeroDocumentPhysicalIdentity(result);
  return result;
}

function planPostimage(plan: DocumentPlan) {
  return {
    bytes: Buffer.from(plan.output.contentBase64, "base64"),
    digest: plan.output.digest,
    mode: 0o644,
    size: plan.output.size
  };
}

async function assertPublicationAncestryStable(
  consumerRoot: string,
  repositoryPath: string,
  before: Awaited<ReturnType<typeof recaptureDocumentPublicationPaths>>
): Promise<void> {
  const after = await recaptureDocumentPublicationPaths({
    consumerRoot,
    destination: repositoryPath
  });
  if (before.destinationPath !== after.destinationPath ||
    !sameDocumentAncestry(before.ancestryIdentities, after.ancestryIdentities)) {
    throw new Error("Document path ancestry changed while filesystem state was read.");
  }
}

function conflict(error: unknown): { readonly state: "conflict"; readonly reason: string } {
  return {
    state: "conflict",
    reason: typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Filesystem state is unverifiable."
  };
}

function unverifiable(error: unknown): {
  readonly state: "unverifiable";
  readonly reason: string;
} {
  return {
    state: "unverifiable",
    reason: typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Filesystem state is unverifiable."
  };
}

export class NodeDocumentFileState implements DocumentFileState {
  async classifyDerivedTemporary(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentDerivedTemporaryState> {
    request.signal?.throwIfAborted();
    const path = documentTemporaryPath(
      request.plan.destination,
      request.plan.planDigest
    );
    try {
      const paths = await recaptureDocumentPublicationPaths({
        consumerRoot: request.consumerRoot,
        destination: path
      });
      request.signal?.throwIfAborted();
      let observed;
      try {
        observed = await readBoundedRegularFile(
          paths.destinationPath,
          MAXIMUM_DOCUMENT_BYTES
        );
      } catch (error) {
        if (error instanceof Error && "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT") {
          await assertPublicationAncestryStable(
            request.consumerRoot,
            path,
            paths
          );
          return { state: "absent" };
        }
        throw error;
      }
      request.signal?.throwIfAborted();
      await assertPublicationAncestryStable(request.consumerRoot, path, paths);
      if (observed.outcome !== "read") {
        return unverifiable("Derived document temporary is not a stable regular file.");
      }
      const identityValue = wireIdentity(observed.identity);
      return {
        state: "present",
        path,
        identity: identityValue
      };
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw error;
      }
      return unverifiable(error);
    }
  }

  async classifyDestination(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentDestinationState> {
    try {
      request.signal?.throwIfAborted();
      const paths = await recaptureDocumentPublicationPaths({
        consumerRoot: request.consumerRoot,
        destination: request.plan.destination
      });
      request.signal?.throwIfAborted();
      let observed;
      try {
        observed = await readBoundedRegularFile(
          paths.destinationPath,
          request.plan.output.size
        );
      } catch (error) {
        if (error instanceof Error && "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT") {
          await assertPublicationAncestryStable(
            request.consumerRoot,
            request.plan.destination,
            paths
          );
          return { state: "absent" };
        }
        throw error;
      }
      request.signal?.throwIfAborted();
      await assertPublicationAncestryStable(
        request.consumerRoot,
        request.plan.destination,
        paths
      );
      const expected = planPostimage(request.plan);
      if (observed.outcome !== "read" ||
        observed.bytes.byteLength !== expected.size ||
        digest(observed.bytes) !== expected.digest ||
        (process.platform !== "win32" && (observed.mode & 0o777) !== expected.mode)) {
        return conflict("Document destination is not the exact Plan output.");
      }
      return { state: "exact", identity: wireIdentity(observed.identity) };
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw error;
      }
      return unverifiable(error);
    }
  }

  async classifyTemporary(request: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<DocumentTemporaryState> {
    request.signal?.throwIfAborted();
    const expected = identity(request.temporary);
    if (expected === undefined) {
      return unverifiable("Document temporary has invalid or zero physical identity.");
    }
    if (!isDocumentRepositoryPath(request.temporary.path)) {
      return unverifiable("Document temporary path is not portable.");
    }
    try {
      const paths = await recaptureDocumentPublicationPaths({
        consumerRoot: request.consumerRoot,
        destination: request.temporary.path
      });
      let observed;
      try {
        request.signal?.throwIfAborted();
        observed = await readBoundedRegularFile(paths.destinationPath, MAXIMUM_DOCUMENT_BYTES);
      } catch (error) {
        if (error instanceof Error && "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT") {
          await assertPublicationAncestryStable(
            request.consumerRoot,
            request.temporary.path,
            paths
          );
          return { state: "absent" };
        }
        throw error;
      }
      request.signal?.throwIfAborted();
      await assertPublicationAncestryStable(
        request.consumerRoot,
        request.temporary.path,
        paths
      );
      if (observed.outcome !== "read" ||
        !sameDocumentPhysicalIdentity(observed.identity, expected) ||
        digest(observed.bytes) !== request.temporary.digest ||
        (process.platform !== "win32" && (observed.mode & 0o777) !== 0o644)) {
        return conflict("Document temporary does not match its exact owned evidence.");
      }
      return { state: "owned-exact", temporary: request.temporary };
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw error;
      }
      return unverifiable(error);
    }
  }
}
