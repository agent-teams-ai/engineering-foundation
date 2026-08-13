import { createHash } from "node:crypto";

import { readBoundedRegularFile } from "../../../repository-mutation/adapters/node/node-bounded-regular-file.js";
import { classifyExactFilePostimageWith } from "../../../repository-mutation/adapters/node/node-absent-file-publication-private.js";
import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";
import type { DocumentOwnedTemporary } from "../../application/model/document-transaction.js";
import type { DocumentPlan } from "../../application/model/document-planning.js";
import type {
  DocumentDestinationState,
  DocumentFileState,
  DocumentTemporaryState
} from "../../application/ports/document-file-state.js";
import { isDocumentRepositoryPath } from "../../application/policies/document-repository-path.js";
import {
  recaptureDocumentPublicationPaths,
  sameDocumentPhysicalIdentity
} from "./recapture-document-publication-paths.js";

const MAXIMUM_DOCUMENT_BYTES = 1_048_576;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function identity(temporary: DocumentOwnedTemporary): PortablePathIdentity | undefined {
  const decimal = /^(?:0|[1-9][0-9]{0,31})$/u;
  const value = temporary.identity;
  if (value.adapter !== "node-filesystem" || value.version !== 1 ||
    ![value.dev, value.ino, value.birthtimeNs].every((part) => decimal.test(part))) {
    return undefined;
  }
  const result = {
    dev: BigInt(value.dev),
    ino: BigInt(value.ino),
    birthtimeNs: BigInt(value.birthtimeNs)
  };
  return result.dev === 0n || result.ino === 0n || result.birthtimeNs === 0n
    ? undefined
    : result;
}

function planPostimage(plan: DocumentPlan) {
  return {
    bytes: Buffer.from(plan.output.contentBase64, "base64"),
    digest: plan.output.digest,
    mode: 0o644,
    size: plan.output.size
  };
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

export class NodeDocumentFileState implements DocumentFileState {
  async classifyDestination(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
  }): Promise<DocumentDestinationState> {
    try {
      const paths = await recaptureDocumentPublicationPaths({
        consumerRoot: request.consumerRoot,
        destination: request.plan.destination
      });
      const state = await classifyExactFilePostimageWith(
        readBoundedRegularFile,
        paths.destinationPath,
        planPostimage(request.plan)
      );
      return state === "conflict" ? conflict("Document destination is not the exact Plan output.") : { state };
    } catch (error) {
      return conflict(error);
    }
  }

  async classifyTemporary(request: {
    readonly consumerRoot: string;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<DocumentTemporaryState> {
    const expected = identity(request.temporary);
    if (expected === undefined) {
      return conflict("Document temporary has invalid or zero physical identity.");
    }
    if (!isDocumentRepositoryPath(request.temporary.path)) {
      return conflict("Document temporary path is not portable.");
    }
    try {
      const paths = await recaptureDocumentPublicationPaths({
        consumerRoot: request.consumerRoot,
        destination: request.temporary.path
      });
      let observed;
      try {
        observed = await readBoundedRegularFile(paths.destinationPath, MAXIMUM_DOCUMENT_BYTES);
      } catch (error) {
        if (error instanceof Error && "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT") {
          return { state: "absent" };
        }
        throw error;
      }
      if (observed.outcome !== "read" ||
        !sameDocumentPhysicalIdentity(observed.identity, expected) ||
        digest(observed.bytes) !== request.temporary.digest ||
        (process.platform !== "win32" && (observed.mode & 0o777) !== 0o644)) {
        return conflict("Document temporary does not match its exact owned evidence.");
      }
      return { state: "owned-exact", temporary: request.temporary };
    } catch (error) {
      return conflict(error);
    }
  }
}
