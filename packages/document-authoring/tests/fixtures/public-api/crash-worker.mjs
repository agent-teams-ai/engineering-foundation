import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Test setup alone uses the installed package's private fault seam: the public
// qualification request accepts only v2. This does not add a consumer API or
// pretend that v1 is a valid V2 request. All recovery calls use public exports.
const { applyNodeDocumentationPlanPrivately } = await import(new URL(
  "./composition/node-document-writing-private.js",
  import.meta.resolve("@agent-teams/document-authoring")
));
const [consumerRoot, planPath, checkpoint] = process.argv.slice(2);
assert.ok(["after-publishing-journal-durable", "after-published-journal-durable"].includes(checkpoint));
const plan = JSON.parse(await readFile(planPath, "utf8"));
await applyNodeDocumentationPlanPrivately({ consumerRoot, plan }, {
  faultInjector({ phase }) {
    if (phase === checkpoint) { process.kill(process.pid, "SIGKILL"); }
  }
});
assert.fail("The writer completed without reaching its durable crash checkpoint.");
