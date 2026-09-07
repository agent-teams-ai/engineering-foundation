export type DocumentCatalogErrorCode =
  | "DOCUMENT_CATALOG_AUTHORITY_CHANGED"
  | "DOCUMENT_CATALOG_AUTHORITY_UNAVAILABLE"
  | "DOCUMENT_CATALOG_INPUT_INVALID";

export class DocumentCatalogError extends Error {
  readonly code: DocumentCatalogErrorCode;

  constructor(
    code: DocumentCatalogErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DocumentCatalogError";
    this.code = code;
  }
}
