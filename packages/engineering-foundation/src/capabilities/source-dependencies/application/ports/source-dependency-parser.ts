import type {
  ParsedSourceDependencies,
  SourceFileSnapshot
} from "../model/source-workspace.js";

export interface SourceDependencyParser {
  parse(file: SourceFileSnapshot): ParsedSourceDependencies;
}
