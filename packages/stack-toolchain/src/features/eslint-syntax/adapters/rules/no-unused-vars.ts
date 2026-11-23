// Retained typescript-eslint 8.59.1 no-unused-vars decisions (MIT).
// Functions were separated to preserve existing maintainability budgets.
import { createRule } from "../create-rule.js";
import { meta } from "./no-unused-vars/metadata.js";
import { translateOptions } from "./no-unused-vars/options.js";
import { ambientListeners } from "./no-unused-vars/ambient.js";
import { programExit } from "./no-unused-vars/exit.js";
import type { MessageIds, Options, RuleState } from "./no-unused-vars/contracts.js";
export type { MessageIds, Options } from "./no-unused-vars/contracts.js";

export default createRule<Options, MessageIds>({
  name: "no-unused-vars",
  meta,
  defaultOptions: [{}],
  create(context, [firstOption]) {
    const state: RuleState = {
      context,
      options: translateOptions(firstOption),
      reportedUnusedVariables: new Set(),
      MODULE_DECL_CACHE: new Map(),
    };
    return {
      ...ambientListeners(state),
      "Program:exit"(node) {
        programExit(state, node);
      },
    };
  },
});
