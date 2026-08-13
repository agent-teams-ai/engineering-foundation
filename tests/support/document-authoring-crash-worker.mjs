import { readFile } from "node:fs/promises";

import { applyNodeDocumentationPlanPrivately } from "../../packages/engineering-foundation/dist/document-authoring/composition/node-document-writing-private.js";

const [consumerRoot, planPath, checkpoint] = process.argv.slice(2);
if (consumerRoot === undefined || planPath === undefined || checkpoint === undefined) {
  throw new Error("Expected consumer root, Plan path, and crash checkpoint.");
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
await applyNodeDocumentationPlanPrivately(
  { consumerRoot, plan },
  {
    faultInjector: async (point) => {
      if (point.phase !== checkpoint) {
        return;
      }
      await new Promise((resolve, reject) => {
        process.stdout.write(`CHECKPOINT:${point.phase}\n`, (error) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await new Promise(() => {});
    }
  }
);
