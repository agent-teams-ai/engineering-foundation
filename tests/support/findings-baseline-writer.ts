import { once } from "node:events";

import { FilesystemFindingsBaselineStore } from "../../packages/engineering-foundation/dist/capabilities/findings-baseline/adapters/outbound/filesystem/filesystem-findings-baseline-store.js";
import { CapabilityInputError } from "../../packages/engineering-foundation/dist/features/validation-reporting/api.js";
import {
  pathTraversesSymbolicLink,
  readContainedRegularFile,
} from "../../packages/engineering-foundation/dist/source-inventory/node.js";

const [root, path, text, expected] = process.argv.slice(2);
if (root === undefined || path === undefined || text === undefined || expected === undefined) {
  throw new Error("The isolated baseline writer requires its exact fixture inputs.");
}
let observed = false;
const store = new FilesystemFindingsBaselineStore({
  pathTraversesSymbolicLink,
  async read(input) {
    const bytes = await readContainedRegularFile(input);
    if (!observed) {
      observed = true;
      const resume = once(process, "message");
      process.send?.("read");
      const [message] = await resume;
      if (message !== "continue") {
        throw new Error("Unexpected baseline writer barrier command.");
      }
    }
    return bytes;
  },
});
try {
  await store.replace(root, path, text, expected);
  process.send?.("success");
} catch (error) {
  process.send?.(
    error instanceof CapabilityInputError ? `failure:${error.problem.code}` : "failure:unexpected",
  );
} finally {
  process.disconnect();
}
