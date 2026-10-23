export { executesScript } from "../../packages/engineering-foundation/dist/features/quality-coverage/api.js";
export const productionGates = [
  ["lint:typed", "node tools/repository-command.mts tool lint:typed"],
  ["architecture:patterns", "node tools/repository-command.mts tool architecture:patterns"],
];
