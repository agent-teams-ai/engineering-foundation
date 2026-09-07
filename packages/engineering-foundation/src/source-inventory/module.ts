import { FilesystemSourceTreeReader } from "./adapters/outbound/filesystem/filesystem-source-tree-reader.js";
import type { SourceTreeReader } from "./api.js";

export function createSourceTreeReader(): SourceTreeReader {
  return new FilesystemSourceTreeReader();
}
