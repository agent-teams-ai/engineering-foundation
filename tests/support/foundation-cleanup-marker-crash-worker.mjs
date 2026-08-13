import { rename } from "node:fs/promises";

import { createNodeFoundationCleanupTransition } from "../../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-cleanup-transition.js";
import { syncFoundationStateDirectoryStrictly } from "../../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-state-directory.js";

const [consumerRoot, checkpoint] = process.argv.slice(2);
if (consumerRoot === undefined || checkpoint === undefined) {
  throw new Error("Expected consumer root and cleanup marker checkpoint.");
}

const token = "c".repeat(64);

async function reached(name) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`CHECKPOINT:${name}\n`, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  await new Promise(() => {});
}

if (checkpoint === "after-marker-synced") {
  await createNodeFoundationCleanupTransition(consumerRoot, token).begin();
  await reached(checkpoint);
} else if (checkpoint === "after-marker-retirement-synced") {
  let retirementRenamed = false;
  let postRenameSyncs = 0;
  const active = await createNodeFoundationCleanupTransition(
    consumerRoot,
    token,
    {
      async rename(source, destination) {
        await rename(source, destination);
        retirementRenamed = true;
      },
      async syncStateDirectory(path) {
        await syncFoundationStateDirectoryStrictly(path);
        if (retirementRenamed) {
          postRenameSyncs += 1;
          if (postRenameSyncs === 2) {
            await reached(checkpoint);
          }
        }
      }
    }
  ).begin();
  await active.complete();
} else {
  throw new Error(`Unknown cleanup marker checkpoint: ${checkpoint}`);
}
