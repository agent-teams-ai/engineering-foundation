import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Test setup alone uses the installed package's private fault seam: the public
// qualification request accepts only v2. This does not add a consumer API or
// pretend that v1 is a valid V2 request. All recovery calls use public exports.
const { applyNodeDocumentationPlan } = await import(new URL(
  "./document-authoring/adapters/node/node-document-writing.js",
  import.meta.resolve("@agent-teams/document-authoring")
));
const { createNodeDocumentAuthority } = await import(new URL("./document-authoring/module.js", import.meta.resolve("@agent-teams/document-authoring")));
const { FilesystemMarkdownRepository, readContainedRegularFile, readMarkdownSyntax } = await import(new URL("./documentation-observation/module.js", import.meta.resolve("@agent-teams/document-authoring")));
const authority = createNodeDocumentAuthority({ repository: new FilesystemMarkdownRepository(), readFile: readContainedRegularFile, syntax: readMarkdownSyntax });
const [consumerRoot, planPath, checkpoint] = process.argv.slice(2);
assert.ok(["after-publishing-journal-durable", "after-published-journal-durable"].includes(checkpoint));
const plan = JSON.parse(await readFile(planPath, "utf8"));
await applyNodeDocumentationPlan({ consumerRoot, plan }, authority, {
  faultInjector({ phase }) {
    if (phase === checkpoint) { process.kill(process.pid, "SIGKILL"); }
  }
});
assert.fail("The writer completed without reaching its durable crash checkpoint.");
