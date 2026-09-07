import { createNodeDocumentAuthority } from "../../packages/document-authoring/dist/document-authoring/module.js";
import { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } from "../../packages/document-authoring/dist/documentation-observation/module.js";
import { readFile } from "node:fs/promises";

import { applyNodeDocumentationPlan as applyNodeDocumentationPlanWithAuthority } from "../../packages/document-authoring/dist/document-authoring/adapters/node/node-document-writing.js";

const observation = { repository: new FilesystemMarkdownRepository(), readFile: readContainedRegularFile, syntax: readMarkdownSyntax };
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

function applyNodeDocumentationPlanPrivately(request, operations) { return applyNodeDocumentationPlanWithAuthority(request, createNodeDocumentAuthority(observation), operations); }
