export { containsScriptRoute as executesScript } from "../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
export const productionGates = [
  ["lint:typed", "node packages/engineering-foundation/dist/cli.js quality check --consumer ."],
  ["architecture:patterns", "node scripts/run-ast-grep.mjs scan --config sgconfig.yml --error=unused-suppression"]
];
