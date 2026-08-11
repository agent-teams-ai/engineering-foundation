import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  ContainedFileReadError,
  readContainedRegularFile
} from "../../../filesystem-path-safety.js";
import type {
  DocumentAuthorityDigest,
  DocumentAuthorityEvidence
} from "../../application/model/document-catalog.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";

const WINDOWS_DEVICE_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export interface DocumentAuthorityFile {
  readonly bytes: Buffer;
  readonly evidence: DocumentAuthorityEvidence;
  readonly source: string;
}

function inputInvalid(message: string, options?: ErrorOptions): never {
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_INPUT_INVALID",
    message,
    options
  );
}

function assertPortableDocumentAuthorityPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.length > 512 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    !/^[A-Za-z0-9._@/-]+$/u.test(path) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        WINDOWS_DEVICE_COMPONENT.test(segment)
    )
  ) {
    inputInvalid(
      "Document authority paths must use the portable repository-relative path grammar."
    );
  }
}

function decodeAuthoritySource(bytes: Buffer, path: string): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    inputInvalid(`Document authority must not contain a UTF-8 BOM: ${path}.`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    inputInvalid(`Document authority must contain well-formed UTF-8: ${path}.`, {
      cause: error
    });
  }
  if (source.includes("\u0000")) {
    inputInvalid(`Document authority must not contain NUL characters: ${path}.`);
  }
  return source;
}

function digest(bytes: Buffer): DocumentAuthorityDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function unavailable(path: string, error: ContainedFileReadError): never {
  const detail =
    error.failure === "symlink"
      ? "cannot traverse a symbolic link"
      : error.failure === "invalid"
        ? "must be a bounded regular file"
        : error.failure === "escape"
          ? "escapes the repository"
          : "is unavailable or changed while reading";
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_AUTHORITY_UNAVAILABLE",
    `Document authority ${detail}: ${path}.`,
    { cause: error }
  );
}

export async function readDocumentAuthorityFile(request: {
  readonly consumerRoot: string;
  readonly maxBytes: number;
  readonly path: string;
}): Promise<DocumentAuthorityFile> {
  assertPortableDocumentAuthorityPath(request.path);
  let bytes: Buffer;
  try {
    bytes = await readContainedRegularFile({
      candidate: resolve(request.consumerRoot, request.path),
      maxBytes: request.maxBytes,
      root: request.consumerRoot
    });
  } catch (error) {
    if (error instanceof ContainedFileReadError) {
      unavailable(request.path, error);
    }
    throw error;
  }
  if (bytes.length === 0) {
    inputInvalid(`Document authority must not be empty: ${request.path}.`);
  }
  const source = decodeAuthoritySource(bytes, request.path);
  return Object.freeze({
    bytes,
    evidence: Object.freeze({
      digest: digest(bytes),
      path: request.path,
      size: bytes.byteLength
    }),
    source
  });
}
