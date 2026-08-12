import type { MarkdownDocumentObservation } from "../../../documentation-observation/application/model/markdown-document.js";
import type {
  DocumentDescriptor,
  DocumentIdentityProjectionEntry
} from "../model/document-catalog.js";
import { catalogDiagnostic } from "./document-catalog-diagnostics.js";
import { isDocumentRepositoryPath } from "./document-repository-path.js";

const OPAQUE_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u;
const LOWER_ID = /^[a-z0-9][a-z0-9._/-]*$/u;

type DocumentFields = Omit<
  DocumentDescriptor,
  "repositoryPath" | "source" | "title"
>;

export type DocumentFieldInspection =
  | {
      readonly fields?: never;
      readonly identity?: DocumentIdentityProjectionEntry;
    }
  | {
      readonly fields: DocumentFields;
      readonly identity: DocumentIdentityProjectionEntry;
    };

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function stringField(
  metadata: Record<string, unknown>,
  field: string,
  maximumLength: number,
  pattern?: RegExp
): string | undefined {
  const value = metadata[field];
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !containsControlCharacter(value) &&
    (pattern === undefined || pattern.test(value))
  )
    ? value
    : undefined;
}

export function inspectDocumentFields(
  document: MarkdownDocumentObservation,
  metadata: Record<string, unknown>
): DocumentFieldInspection {
  const id = stringField(metadata, "id", 214, OPAQUE_ID);
  const type = stringField(metadata, "type", 160, LOWER_ID);
  const status = stringField(metadata, "status", 160, LOWER_ID);
  const owner = stringField(metadata, "owner", 214, OPAQUE_ID);
  const summary = stringField(metadata, "summary", 1000);
  if (
    id === undefined ||
    type === undefined ||
    status === undefined ||
    owner === undefined ||
    summary === undefined
  ) {
    return id === undefined
      ? Object.freeze({})
      : Object.freeze({
          identity: Object.freeze({ id, repositoryPath: document.repositoryPath })
        });
  }
  return Object.freeze({
    fields: Object.freeze({ id, owner, status, summary, type }),
    identity: Object.freeze({ id, repositoryPath: document.repositoryPath })
  });
}

export function documentTitle(
  document: MarkdownDocumentObservation
): string | undefined {
  const title = document.headings.find((heading) => heading.depth === 1)?.text;
  return title !== undefined &&
    title.length > 0 &&
    title.length <= 240 &&
    !containsControlCharacter(title)
    ? title
    : undefined;
}

export function invalidDocumentPathInspection(
  document: MarkdownDocumentObservation
): { readonly diagnostic: ReturnType<typeof catalogDiagnostic> } | undefined {
  return isDocumentRepositoryPath(document.repositoryPath)
    ? undefined
    : Object.freeze({
        diagnostic: catalogDiagnostic(
          "document.catalog.path-invalid",
          document.repositoryPath,
          "Catalog document paths must use the portable repository path grammar."
        )
      });
}
