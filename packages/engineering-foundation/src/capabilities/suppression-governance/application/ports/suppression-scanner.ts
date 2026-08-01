import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";
import type { SuppressionScan } from "../model/suppression-governance.js";

export interface SuppressionScanner {
  scan(file: SourceFileSnapshot): SuppressionScan;
}
