import {
  mergeCoverageEvidence,
  parseCoverageEvidenceArguments,
} from "./coverage-evidence.mjs";

await mergeCoverageEvidence(parseCoverageEvidenceArguments(process.argv.slice(2)));
