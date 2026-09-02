import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { reconcileGithubTagRelease } from "../scripts/github-release-reconciliation.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpmHooks = createRequire(import.meta.url)("../.pnpmfile.cjs").hooks;

test("pnpm packing canonicalizes publish-manifest key order", () => {
  const input = {
    version: "0.0.0",
    name: "@fixture/package",
    dependencies: { zeta: "1.0.0", alpha: "1.0.0", "@fixture/core": "1.0.0" },
  };
  const packed = pnpmHooks.beforePacking(input);

  assert.deepEqual(Object.keys(packed), ["dependencies", "name", "version"]);
  assert.deepEqual(Object.keys(packed.dependencies), ["@fixture/core", "alpha", "zeta"]);
  assert.deepEqual(Object.keys(input.dependencies), ["zeta", "alpha", "@fixture/core"]);
});

async function workflow(name) {
  return parseYaml(await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"));
}

function assertOrdered(source, values) {
  let offset = 0;
  for (const value of values) {
    const index = source.indexOf(value, offset);
    assert.notEqual(index, -1, `Missing ordered workflow evidence: ${value}`);
    offset = index + value.length;
  }
}

test("generic npm bootstrap is manual, token-bounded, idempotent, and provenance-verified", async () => {
  const bootstrap = await workflow("npm-package-bootstrap.yml");
  const source = await readFile(
    join(repositoryRoot, ".github", "workflows", "npm-package-bootstrap.yml"),
    "utf8",
  );
  const registrySource = await readFile(
    join(repositoryRoot, "scripts", "npm-package-bootstrap-registry.mjs"),
    "utf8",
  );
  const cliSource = await readFile(
    join(repositoryRoot, "scripts", "npm-package-bootstrap-cli.mjs"),
    "utf8",
  );
  const packTestSupportSource = await readFile(
    join(repositoryRoot, "scripts", "pack-test-support.mjs"),
    "utf8",
  );
  const ci = await workflow("ci.yml");
  const release = await workflow("release.yml");
  const repositoryManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const job = bootstrap.jobs.bootstrap;
  const ciWriter = ci.jobs["linux-package"];
  const publish = job.steps.find(
    ({ name }) => name === "Publish, resume, or quarantine the exact bootstrap artifact",
  );
  const postconditions = job.steps.find(
    ({ name }) => name === "Prove registry postconditions and provenance",
  );
  const reuseProof = job.steps.find(
    ({ name }) => name === "Prove an existing artifact before reuse",
  );
  const quarantineProof = job.steps.find(
    ({ name }) => name === "Prove an exact uncertain artifact before quarantine",
  );
  const quarantinePostconditions = job.steps.find(
    ({ name }) => name === "Prove quarantine postconditions",
  );
  const reconcile = bootstrap.jobs["reconcile-github"];
  const reconcileStep = reconcile.steps.find(
    ({ name }) => name === "Create or reuse the exact tag and prerelease",
  );

  assert.deepEqual(Object.keys(bootstrap.on), ["workflow_dispatch"]);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.package_id.type, "string");
  assert.equal(bootstrap.on.workflow_dispatch.inputs.package_id.options, undefined);
  assert.deepEqual(bootstrap.on.workflow_dispatch.inputs.operation.options, ["bootstrap", "quarantine"]);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.expected_commit.required, true);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.token_created_at.required, true);
  assert.equal(bootstrap.on.workflow_dispatch.inputs.token_expires_at.required, true);
  assert.deepEqual(bootstrap.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" });
  assert.equal(job.environment, "npm-package-bootstrap");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(ciWriter["runs-on"], job["runs-on"]);
  assert.equal(repositoryManifest.packageManager, "pnpm@11.20.0");
  assert.equal(job.steps[1].uses, ciWriter.steps[1].uses);
  assert.equal(job.steps[1].with.install, false);
  assert.equal(job.steps[2].uses, ciWriter.steps[2].uses);
  assert.equal(job.steps[2].with["node-version-file"], ".node-version");
  assert.equal(ciWriter.steps[2].with["node-version-file"], job.steps[2].with["node-version-file"]);
  assert.match(job.if, /NPM_PACKAGE_BOOTSTRAP_ENABLED.*refs\/heads\/main.*expected_commit/u);
  assert.equal(job.env.NPM_TOKEN, undefined);
  assert.equal(job.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(publish.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_PACKAGE_BOOTSTRAP_TOKEN }}");
  assert.equal(job.steps.filter(({ env }) => env?.NODE_AUTH_TOKEN !== undefined).length, 1);
  assert.match(publish.run, /test "\$\{NODE_AUTH_TOKEN\}" != ""/u);
  assert.match(publish.run, /npm_token="\$\{NODE_AUTH_TOKEN\}"\s+unset NODE_AUTH_TOKEN/u);
  assert.match(publish.run, /NODE_AUTH_TOKEN="\$\{npm_token\}"[\s\\]+npm publish/u);
  assert.doesNotMatch(publish.run, /npm dist-tag/u);
  assert.match(publish.run, /NODE_AUTH_TOKEN="\$\{npm_token\}"[\s\\]+npm deprecate/u);
  assert.match(publish.run, /git ls-remote --exit-code origin refs\/heads\/main/u);
  assert.match(publish.run, /assert_token_window/u);
  assert.match(publish.run, /quarantine-final-proof/u);
  assert.match(publish.run, /npm publish "\$\{ARCHIVE_PATH\}" --tag bootstrap --provenance --ignore-scripts/u);
  assert.match(publish.run, /mutation-proof/u);
  assert.match(publish.run, /npm deprecate "\$\{PACKAGE_TAG\}"/u);
  const quarantineBranch = publish.run.slice(
    publish.run.indexOf('if [[ "${OPERATION}" == "quarantine" ]]'),
    publish.run.indexOf('test "${OPERATION}" = "bootstrap"'),
  );
  const publishBranch = publish.run.slice(
    publish.run.indexOf('if [[ "${REGISTRY_ACTION}" == "publish" ]]'),
    publish.run.indexOf('elif [[ "${REGISTRY_ACTION}" != "reuse" ]]'),
  );
  const postPublishBranch = publish.run.slice(publish.run.indexOf("mutation-proof"));
  assertOrdered(quarantineBranch, [
    "assert_fresh_main_bounded", "quarantine-final-proof", "assert_fresh_main",
    "assert_token_window", "npm deprecate",
  ]);
  assertOrdered(publishBranch, [
    "assert_fresh_main_bounded", "registry-final-preflight", "assert_fresh_main",
    "assert_token_window", "npm publish",
  ]);
  assertOrdered(postPublishBranch, [
    "mutation-proof", "assert_fresh_main_bounded", "quarantine-final-proof",
    "assert_fresh_main", "assert_token_window", "npm deprecate",
  ]);
  assert.match(cliSource, /"registry-final-preflight": \(args\) => registryPreflight\(args, \{ attempts: 1 \}\)/u);
  assert.match(cliSource, /"quarantine-final-proof"[\s\S]*?\{ attempts: 1 \}/u);
  assert.match(reuseProof.if, /steps\.registry\.outputs\.action == 'reuse'/u);
  assert.equal(reuseProof.env.NODE_AUTH_TOKEN, undefined);
  assert.match(reuseProof.run, /reuse-proof/u);
  assert.ok(job.steps.indexOf(reuseProof) < job.steps.indexOf(publish));
  assert.match(quarantineProof.if, /inputs\.operation == 'quarantine'/u);
  assert.equal(quarantineProof.env.NODE_AUTH_TOKEN, undefined);
  assert.match(quarantineProof.run, /quarantine-proof/u);
  assert.ok(job.steps.indexOf(quarantineProof) < job.steps.indexOf(publish));
  assert.match(postconditions.run, /postconditions/u);
  assert.match(postconditions.if, /inputs\.operation == 'bootstrap'/u);
  assert.match(quarantinePostconditions.run, /quarantine-postconditions/u);
  assert.match(reconcile.if, /inputs\.operation == 'bootstrap'/u);
  assert.match(registrySource, /"audit", "signatures", "--json", "--include-attestations"/u);
  assert.match(registrySource, /`--@agent-teams:registry=\$\{registry\}`/u);
  assert.match(registrySource, /runNpmCommand/u);
  assert.doesNotMatch(registrySource, /execFile|npm\.cmd/u);
  assert.doesNotMatch(
    packTestSupportSource,
    /^import .*windows-managed-process/u,
    "pre-build release guards must not resolve built Windows adapters during module loading",
  );
  assert.match(
    packTestSupportSource,
    /process\.platform !== "win32"[\s\S]*?await import\([\s\S]*?windows-managed-process\.js/u,
  );
  assert.equal(reconcile.needs, "bootstrap");
  assert.deepEqual(reconcile.permissions, { contents: "write" });
  assert.match(reconcile.steps[0].uses, /^actions\/checkout@[a-f0-9]{40}$/u);
  assert.equal(reconcile.steps[0].with.ref, "${{ inputs.expected_commit }}");
  assert.equal(reconcile.steps[0].with["persist-credentials"], false);
  assert.match(reconcile.steps[1].uses, /^actions\/setup-node@[a-f0-9]{40}$/u);
  assert.equal(reconcile.steps[1].with["node-version-file"], ".node-version");
  assert.equal(reconcileStep.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(reconcileStep.env.NODE_AUTH_TOKEN, undefined);
  assert.match(reconcileStep.run, /scripts\/github-release-reconciliation\.mjs/u);
  assert.match(reconcileStep.run, /"\$\{TAG\}" "\$\{TITLE\}" "\$\{BODY\}" true "\$\{EXPECTED_COMMIT\}"/u);
  assert.doesNotMatch(reconcileStep.run, /gh api|git\/ref\/tags|releases\/tags/u);
  assert.doesNotMatch(source, /on:\s*\n\s+push:/u);
  assert.doesNotMatch(source, /docs-protocol-bootstrap/u);
  assert.equal(
    release.jobs.release.steps.find(({ name }) => name === "Guard public package bootstrap baselines").run,
    "node scripts/npm-package-bootstrap-cli.mjs check-release",
  );
  assert.ok(
    ci.jobs["linux-package"].steps.some(
      ({ run }) => run === "node scripts/npm-package-bootstrap-local-evidence.mjs",
    ),
  );
});

test("shared reconciliation resolves annotated tags and re-reads final exact state", async () => {
  const commit = "a".repeat(40);
  const annotated = "b".repeat(40);
  const policy = {
    body: "Bootstrap-only artifact. Do not adopt.",
    prerelease: true,
    tag: "@agent-teams/docs-protocol-mcp@0.0.0",
    title: "@agent-teams/docs-protocol-mcp 0.0.0 bootstrap",
  };
  const ref = { object: { sha: annotated, type: "tag" } };
  const release = {
    body: policy.body,
    draft: false,
    name: policy.title,
    prerelease: true,
    tag_name: policy.tag,
  };
  let refReads = 0;
  let releaseReads = 0;
  const request = (args) => {
    const route = args[0];
    if (route.includes("/git/ref/tags/")) {
      refReads += 1;
      return ref;
    }
    if (route.endsWith(`/git/tags/${annotated}`)) {
      return { object: { sha: commit, type: "commit" } };
    }
    if (route.includes("/releases/tags/")) {
      releaseReads += 1;
      return release;
    }
    throw new Error(`Unexpected fake GitHub route: ${route}`);
  };

  assert.deepEqual(
    await reconcileGithubTagRelease(policy, commit, {
      expectedMainCommit: "c".repeat(40),
      repository: "agent-teams-ai/engineering-foundation",
      request,
    }),
    { ...policy, commit },
  );
  assert.equal(refReads, 2);
  assert.equal(releaseReads, 2);
});

test("shared reconciliation blocks a missing tag when protected main advanced", async () => {
  const commit = "a".repeat(40);
  let writes = 0;
  const request = (args) => {
    const route = args[0] === "--method" ? args[2] : args[0];
    if (route.includes("/git/ref/tags/")) {
      return;
    }
    if (route.endsWith("/git/ref/heads/main")) {
      return {
        object: { sha: "b".repeat(40), type: "commit" },
        ref: "refs/heads/main",
      };
    }
    if (args[0] === "--method") {
      writes += 1;
    }
    throw new Error(`Unexpected fake GitHub route: ${route}`);
  };

  await assert.rejects(
    reconcileGithubTagRelease({
      body: "Bootstrap-only artifact. Do not adopt.",
      prerelease: true,
      tag: "@agent-teams/docs-protocol-mcp@0.0.0",
      title: "@agent-teams/docs-protocol-mcp 0.0.0 bootstrap",
    }, commit, {
      expectedMainCommit: commit,
      repository: "agent-teams-ai/engineering-foundation",
      request,
    }),
    /protected main advanced/u,
  );
  assert.equal(writes, 0);
});

test("shared reconciliation rejects tag drift on its final read", async () => {
  const commit = "a".repeat(40);
  let reads = 0;
  const policy = {
    body: "Bootstrap-only artifact. Do not adopt.",
    prerelease: true,
    tag: "@agent-teams/docs-protocol-mcp@0.0.0",
    title: "@agent-teams/docs-protocol-mcp 0.0.0 bootstrap",
  };
  const request = (args) => {
    const route = args[0];
    if (route.includes("/git/ref/tags/")) {
      reads += 1;
      return { object: { sha: reads === 1 ? commit : "b".repeat(40), type: "commit" } };
    }
    if (route.includes("/releases/tags/")) {
      return { body: policy.body, draft: false, name: policy.title, prerelease: true, tag_name: policy.tag };
    }
    throw new Error(`Unexpected fake GitHub route: ${route}`);
  };

  await assert.rejects(
    reconcileGithubTagRelease(policy, commit, {
      repository: "agent-teams-ai/engineering-foundation",
      request,
    }),
    /Final .* not bound to the trusted release commit/u,
  );
  assert.equal(reads, 2);
});
