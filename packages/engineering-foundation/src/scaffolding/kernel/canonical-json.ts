import {
  canonicalJson as canonicalRepositoryMutationJson,
  sha256Bytes as sha256RepositoryMutationBytes,
  sha256Json as sha256RepositoryMutationJson,
  sha256Text as sha256RepositoryMutationText
} from "@agent-teams/repository-mutation";

import type {
  JsonValue,
  Sha256Digest
} from "../application/model/scaffold-values.js";
import { ScaffoldError } from "../scaffold-error.js";

function mapCanonicalFailure<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      "Scaffolding JSON does not satisfy the canonical Repository Mutation primitive.",
      [],
      { cause: error }
    );
  }
}

export function canonicalJson(value: JsonValue): string {
  return mapCanonicalFailure(() => canonicalRepositoryMutationJson(value));
}

export function sha256Bytes(value: Uint8Array): Sha256Digest {
  return sha256RepositoryMutationBytes(value);
}

export function sha256Text(value: string): Sha256Digest {
  return sha256RepositoryMutationText(value);
}

export function sha256Json(value: JsonValue): Sha256Digest {
  return mapCanonicalFailure(() => sha256RepositoryMutationJson(value));
}
