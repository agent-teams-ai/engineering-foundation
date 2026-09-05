import type { DocumentFileReader } from "./document-file-reader.js";
import type { DocumentMarkdownRepository } from "./document-markdown-repository.js";
import type { DocumentMarkdownSyntaxReader } from "./document-markdown-syntax-reader.js";

export interface DocumentObservationDependencies {
  readonly readFile: DocumentFileReader;
  readonly repository: DocumentMarkdownRepository;
  readonly syntax: DocumentMarkdownSyntaxReader;
}
