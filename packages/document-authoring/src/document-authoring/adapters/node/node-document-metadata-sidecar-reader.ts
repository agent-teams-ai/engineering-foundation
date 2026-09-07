import { isDocumentInputFailure, assertDocumentAuthoringActive } from "../../application/policies/document-input-failure.js";
import type { DocumentFileReader } from "../../application/ports/document-file-reader.js";


import { parseStrictYamlSource } from "./strict-yaml.js";
import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import type { DocumentMetadataObject } from "../../application/model/document-catalog.js";
import { isDocumentRepositoryPath } from "../../application/policies/document-repository-path.js";
import {
  CatalogMetadataProjectionError,
  projectCatalogMetadata
} from "../../application/policies/project-catalog-metadata.js";
import type {
  DocumentMetadataSidecarReader,
  DocumentMetadataSidecarSnapshot
} from "../../application/ports/document-metadata-sidecar-reader.js";
import { DocumentCatalogError } from "../../application/model/document-catalog-error.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAXIMUM_SIDECAR_BYTES = 1024 * 1024;
const MAXIMUM_SIDECAR_DOCUMENTS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSidecar(message: string, cause?: unknown): never {
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_INPUT_INVALID",
    `Document metadata sidecar is invalid: ${message}`,
    cause === undefined ? undefined : { cause }
  );
}

function projectDocuments(value: unknown): Readonly<Record<string, DocumentMetadataObject>> {
  if (!isRecord(value)) {
    invalidSidecar("documents must be a mapping.");
  }
  const paths = Reflect.ownKeys(value);
  if (paths.some((path) => typeof path !== "string")) {
    invalidSidecar("document paths must be strings.");
  }
  if (paths.length > MAXIMUM_SIDECAR_DOCUMENTS) {
    invalidSidecar(`documents exceeds ${MAXIMUM_SIDECAR_DOCUMENTS} entries.`);
  }
  const projected: Record<string, DocumentMetadataObject> = {};
  for (const path of (paths as string[]).toSorted(compareBinaryStrings)) {
    if (!isDocumentRepositoryPath(path) || !path.toLowerCase().endsWith(".md")) {
      invalidSidecar(`document path is not portable Markdown: ${path}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, path);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      invalidSidecar("documents must contain enumerable own data properties.");
    }
    try {
      projected[path] = projectCatalogMetadata(descriptor.value);
    } catch (error) {
      if (error instanceof CatalogMetadataProjectionError) {
        invalidSidecar(`${path}: ${error.message}`, error);
      }
      throw error;
    }
  }
  return Object.freeze(projected);
}

function parseSidecar(source: string): Readonly<Record<string, DocumentMetadataObject>> {
  let input: unknown;
  try {
    input = parseStrictYamlSource(source, "document-metadata-sidecar");
  } catch (error) {
    if (isDocumentInputFailure(error)) {
      invalidSidecar(error.message, error);
    }
    throw error;
  }
  if (!isRecord(input)) {
    invalidSidecar("root must be an object.");
  }
  const keys = Object.keys(input).toSorted(compareBinaryStrings);
  if (
    keys.length !== 2 ||
    keys[0] !== "contract" ||
    keys[1] !== "documents" ||
    input["contract"] !== "foundation.document-metadata-sidecar/v1"
  ) {
    invalidSidecar(
      "root must contain only contract foundation.document-metadata-sidecar/v1 and documents."
    );
  }
  return projectDocuments(input["documents"]);
}

export class NodeDocumentMetadataSidecarReader
  implements DocumentMetadataSidecarReader
{
  constructor(private readonly readFile: DocumentFileReader) {}
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentMetadataSidecarSnapshot> {
    assertDocumentAuthoringActive(request.signal);
    const file = await readDocumentAuthorityFile(this.readFile, {
      consumerRoot: request.consumerRoot,
      maxBytes: MAXIMUM_SIDECAR_BYTES,
      path: request.path
    });
    const documents = parseSidecar(file.source);
    assertDocumentAuthoringActive(request.signal);
    return Object.freeze({ documents, evidence: file.evidence });
  }
}
