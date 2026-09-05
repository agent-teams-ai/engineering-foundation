import { CapabilityInputError, assertNotCancelled, type ContainedFileReader } from "../../../documentation-observation/api.js";


import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import { parseStrictYamlSource } from "./strict-yaml.js";
import type {
  OwnerMembershipReader,
  OwnerMembershipSnapshot
} from "../../application/ports/owner-membership-reader.js";
import { DocumentCatalogError } from "../../application/model/document-catalog-error.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_OWNER_CATALOG_BYTES = 1024 * 1024;
const MAX_OWNER_COUNT = 4096;
const OWNER_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidOwnerCatalog(message: string, cause?: unknown): never {
  throw new DocumentCatalogError(
    "DOCUMENT_CATALOG_INPUT_INVALID",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function parseOwnerIds(source: string): readonly string[] {
  let input: unknown;
  try {
    input = parseStrictYamlSource(source, "document-owner-catalog");
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      invalidOwnerCatalog("Document owner catalog must contain strict YAML.", error);
    }
    throw error;
  }
  if (!isRecord(input)) {
    invalidOwnerCatalog("Document owner catalog must be an object.");
  }
  const keys = Object.keys(input).toSorted(compareBinaryStrings);
  if (
    keys.length !== 2 ||
    keys[0] !== "owners" ||
    keys[1] !== "version" ||
    input.version !== 1 ||
    !isRecord(input.owners)
  ) {
    invalidOwnerCatalog(
      "Document owner catalog must contain only version 1 and an owners object."
    );
  }
  const owners = input.owners;
  const ids = Object.keys(owners).toSorted(compareBinaryStrings);
  if (ids.length === 0 || ids.length > MAX_OWNER_COUNT) {
    invalidOwnerCatalog(
      `Document owner catalog must contain between 1 and ${MAX_OWNER_COUNT} owners.`
    );
  }
  for (const id of ids) {
    if (id.length > 214 || !OWNER_ID.test(id) || !isRecord(owners[id])) {
      invalidOwnerCatalog(
        "Document owner IDs must be normalized opaque identifiers with object metadata."
      );
    }
  }
  return Object.freeze(ids);
}

export class NodeOwnerMembershipReader implements OwnerMembershipReader {
  constructor(private readonly readFile: ContainedFileReader) {}
  async read(request: {
    readonly consumerRoot: string;
    readonly contract: "foundation.owner-map/v1";
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<OwnerMembershipSnapshot> {
    assertNotCancelled(request.signal);
    const file = await readDocumentAuthorityFile(this.readFile, {
      consumerRoot: request.consumerRoot,
      maxBytes: MAX_OWNER_CATALOG_BYTES,
      path: request.path
    });
    assertNotCancelled(request.signal);
    return Object.freeze({ evidence: file.evidence, ids: parseOwnerIds(file.source) });
  }
}
