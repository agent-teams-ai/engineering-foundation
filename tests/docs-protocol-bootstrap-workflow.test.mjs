import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function workflow(name) {
  return parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"),
  );
}

test("Docs Protocol bootstrap is manual, token-bounded, idempotent, and provenance-verified", async () => {
  const bootstrap = await workflow("docs-protocol-bootstrap.yml");
  const source = await readFile(
    join(repositoryRoot, ".github", "workflows", "docs-protocol-bootstrap.yml"),
    "utf8",
  );
  const release = await workflow("release.yml");
  const job = bootstrap.jobs.bootstrap;
  const publish = job.steps.find(({ name }) => name === "Publish or resume the exact bootstrap artifact");
  const postconditions = job.steps.find(
    ({ name }) => name === "Prove registry postconditions and provenance",
  );
  const reconcile = bootstrap.jobs["reconcile-github"];
  const reconcileStep = reconcile.steps.find(
    ({ name }) => name === "Create or reuse the exact tag and prerelease",
  );

  assert.deepEqual(Object.keys(bootstrap.on), ["workflow_dispatch"]);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.expected_commit.required, true);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.token_created_at.required, true);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.token_expires_at.required, true);
  assert.deepEqual(bootstrap.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" });
  assert.equal(job.environment, "npm-docs-protocol-bootstrap");
  assert.match(job.if, /DOCS_PROTOCOL_BOOTSTRAP_ENABLED.*refs\/heads\/main.*expected_commit/u);
  assert.equal(job.env.NPM_TOKEN, undefined);
  assert.equal(job.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(
    publish.env.NODE_AUTH_TOKEN,
    "${{ secrets.NPM_DOCS_PROTOCOL_BOOTSTRAP_TOKEN }}",
  );
  assert.equal(
    job.steps.filter(({ env }) => env?.NODE_AUTH_TOKEN !== undefined).length,
    1,
  );
  assert.match(publish.run, /test "\$\{NODE_AUTH_TOKEN\}" != ""/u);
  assert.match(publish.run, /npm publish "\$\{archive_path\}" --tag bootstrap --provenance --ignore-scripts/u);
  assert.match(publish.run, /npm dist-tag add '@agent-teams\/docs-protocol@0\.0\.0' bootstrap/u);
  assert.doesNotMatch(publish.run, /dist-tag add .* latest/u);
  assert.match(publish.run, /npm deprecate '@agent-teams\/docs-protocol@0\.0\.0'/u);
  assert.match(postconditions.run, /npm audit signatures --json --include-attestations/u);
  assert.equal(reconcile.needs, "bootstrap");
  assert.deepEqual(reconcile.permissions, { contents: "write" });
  assert.equal(reconcileStep.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(reconcileStep.env.NODE_AUTH_TOKEN, undefined);
  assert.match(reconcileStep.run, /git\/ref\/tags/u);
  assert.match(reconcileStep.run, /\.object\.sha.*EXPECTED_COMMIT/u);
  assert.match(reconcileStep.run, /releases\/tags/u);
  assert.match(reconcileStep.run, /prerelease=true/u);
  assert.match(reconcileStep.run, /target_commitish="\$\{EXPECTED_COMMIT\}"/u);
  assert.match(source, /engineering-foundation@0\.17\.0-rc\.0/u);
  assert.doesNotMatch(source, /on:\s*\n\s+push:/u);
  assert.equal(
    release.jobs.release.steps.find(({ name }) => name === "Guard Docs Protocol bootstrap boundary")
      .run,
    "node scripts/docs-protocol-bootstrap.mjs ordinary-release-state",
  );
});
