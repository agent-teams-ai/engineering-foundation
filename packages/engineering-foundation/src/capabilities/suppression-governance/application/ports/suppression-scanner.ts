import type { SourceFileSnapshot } from "../model/source-file-snapshot.js";
import type { SuppressionScan } from "../model/suppression-governance.js";

export interface SuppressionScanner {
  scan(file: SourceFileSnapshot): SuppressionScan;
}
