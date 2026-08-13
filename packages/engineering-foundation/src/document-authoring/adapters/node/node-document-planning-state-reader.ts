import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertNotCancelled } from "../../../cancellation.js";
import {
  ContainedFileReadError,
  readContainedRegularFile
} from "../../../filesystem-path-safety.js";
import type { DocumentPlanningStateSnapshot } from "../../application/model/document-planning.js";
import type { DocumentPlanningStateReader } from "../../application/ports/document-planning-state-reader.js";
import {
  documentRepositoryParentPath,
  isDocumentRepositoryPath
} from "../../application/policies/document-repository-path.js";
import { DocumentPlanningError } from "../../document-planning-error.js";

const MAX_EXISTING_DESTINATION_BYTES = 1024 * 1024;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR");
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function portableNameIdentity(name: string): string {
  return name.normalize("NFC").replace(/[A-Z]/gu, (character) =>
    character.toLowerCase());
}

async function hasPortableNameCollision(
  parent: string,
  requestedName: string
): Promise<boolean> {
  const requestedIdentity = portableNameIdentity(requestedName);
  const entries = await readdir(parent);
  return entries.some((entry) =>
    entry !== requestedName && portableNameIdentity(entry) === requestedIdentity
  );
}

function parentUnavailable(message: string, cause?: unknown): never {
  throw new DocumentPlanningError(
    "DOCUMENT_PLANNING_PARENT_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause }
  );
}

function observationUnavailable(message: string, cause?: unknown): never {
  throw new DocumentPlanningError(
    "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause }
  );
}

async function observeRegularDestination(input: {
  readonly candidate: string;
  readonly destination: string;
  readonly root: string;
}): Promise<DocumentPlanningStateSnapshot["destination"]> {
  try {
    const bytes = await readContainedRegularFile({
      candidate: input.candidate,
      maxBytes: MAX_EXISTING_DESTINATION_BYTES,
      root: input.root
    });
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      state: "regular-file"
    });
  } catch (error) {
    if (
      error instanceof ContainedFileReadError &&
      (error.failure === "invalid" || error.failure === "symlink")
    ) {
      return Object.freeze({ kind: "special-file", state: "conflict" });
    }
    if (error instanceof ContainedFileReadError) {
      observationUnavailable(
        `Document destination changed or became unavailable: ${input.destination}.`,
        error
      );
    }
    throw error;
  }
}

async function observeRealParent(input: {
  readonly consumerRoot: string;
  readonly destination: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly parent: string; readonly root: string }> {
  const lexicalRoot = resolve(input.consumerRoot);
  let root: string;
  try {
    const rootMetadata = await lstat(lexicalRoot);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      parentUnavailable("Document repository root must be a real directory.");
    }
    root = await realpath(lexicalRoot);
  } catch (error) {
    if (error instanceof DocumentPlanningError) {
      throw error;
    }
    parentUnavailable("Document repository root is unavailable.", error);
  }
  let current = root;
  const parentSegments = input.destination.split("/").slice(0, -1);
  for (const segment of parentSegments) {
    assertNotCancelled(input.signal);
    try {
      if (await hasPortableNameCollision(current, segment)) {
        parentUnavailable(
          `Document destination parent has a portable name collision: ${segment}.`
        );
      }
      const next = join(current, segment);
      const metadata = await lstat(next);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        parentUnavailable(
          `Document destination parent ancestry must contain only real directories: ${segment}.`
        );
      }
      const canonical = await realpath(next);
      if (!contained(root, canonical)) {
        parentUnavailable("Document destination parent escapes the repository.");
      }
      current = canonical;
    } catch (error) {
      if (error instanceof DocumentPlanningError) {
        throw error;
      }
      if (isMissing(error)) {
        parentUnavailable("Document destination parent must already exist.", error);
      }
      parentUnavailable("Document destination parent cannot be observed safely.", error);
    }
  }
  return { parent: current, root };
}

export class NodeDocumentPlanningStateReader
implements DocumentPlanningStateReader {
  async observe(request: {
    readonly consumerRoot: string;
    readonly destination: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentPlanningStateSnapshot> {
    assertNotCancelled(request.signal);
    if (!isDocumentRepositoryPath(request.destination)) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_INPUT_INVALID",
        "Document destination must use the portable repository-relative path grammar."
      );
    }
    const { parent, root } = await observeRealParent(request);
    assertNotCancelled(request.signal);
    const basename = request.destination.split("/").at(-1) ?? "";
    let destination: DocumentPlanningStateSnapshot["destination"];
    try {
      if (await hasPortableNameCollision(parent, basename)) {
        destination = Object.freeze({
          kind: "portable-name-collision",
          state: "conflict"
        });
      } else {
        const candidate = join(parent, basename);
        const metadata = await lstat(candidate).catch((error: unknown) => {
          if (isMissing(error)) {
            return null;
          }
          throw error;
        });
        if (metadata === null) {
          destination = Object.freeze({ state: "absent" });
        } else if (metadata.isSymbolicLink() || !metadata.isFile()) {
          destination = Object.freeze({
            kind: metadata.isDirectory() ? "directory" : "special-file",
            state: "conflict"
          });
        } else {
          destination = await observeRegularDestination({
            candidate,
            destination: request.destination,
            root
          });
        }
      }
    } catch (error) {
      if (error instanceof DocumentPlanningError) {
        throw error;
      }
      observationUnavailable(
        `Document destination cannot be observed safely: ${request.destination}.`,
        error
      );
    }
    assertNotCancelled(request.signal);
    return Object.freeze({
      destination,
      expectedParent: Object.freeze({
        ancestry: "real-directories",
        path: documentRepositoryParentPath(request.destination),
        state: "directory"
      })
    });
  }
}
