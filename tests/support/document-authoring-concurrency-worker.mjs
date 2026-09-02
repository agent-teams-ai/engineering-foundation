import { readFile } from "node:fs/promises";

import { applyNodeDocumentationPlanPrivately } from "../../packages/document-authoring/dist/composition/node-document-writing-private.js";

const [consumerRoot, planPath, checkpoint = "none"] = process.argv.slice(2);
if (consumerRoot === undefined || planPath === undefined) {
  throw new Error("Expected consumer root and Plan path.");
}

function writeMessage(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function waitForRelease() {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", resolve);
  });
}

const plan = JSON.parse(await readFile(planPath, "utf8"));
try {
  const receipt = await applyNodeDocumentationPlanPrivately(
    { consumerRoot, plan },
    checkpoint === "none"
      ? {}
      : {
          faultInjector: async (point) => {
            if (point.phase !== checkpoint) {
              return;
            }
            await writeMessage({ checkpoint: point.phase });
            await waitForRelease();
          }
        }
  );
  await writeMessage({ receipt });
} catch (error) {
  await writeMessage({
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
}
