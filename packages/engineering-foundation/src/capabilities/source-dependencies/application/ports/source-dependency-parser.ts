import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { ParsedSourceDependencies } from "../model/source-workspace.js";

export interface SourceDependencyParser {
  parse(file: SourceFileSnapshot): ParsedSourceDependencies;
}
