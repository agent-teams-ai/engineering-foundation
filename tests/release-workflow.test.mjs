import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  readStreamText,
  releasePullRequestContentViolations,
  releasePullRequestFileViolations,
} from "../scripts/check-release-pr-files.mjs";
import { selectReleaseCiRun } from "../scripts/select-release-ci-run.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reviewRouterRevision = "8a0a31ae1d92c89466c8a939272a1e333e88c5a0";
const reviewRouterSecretName =
  "REVIEWROUTER_CODEX_AUTH_JSON_R1316243988_P2410642c6217c966_E8_3496cd251b94dfa849df4011a4ad0136";

async function workflow(name) {
  return parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"),
  );
}

function assertReviewRouterInteractionRuntime(
  reviewInteraction,
  reviewInteractionSource,
) {
  const interactionJob = reviewInteraction.jobs.interaction;
  assert.deepEqual(interactionJob.permissions, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
    "id-token": "write",
  });
  assert.deepEqual(reviewInteraction.on, {
    pull_request_review_comment: { types: ["created", "edited"] },
    issue_comment: { types: ["created", "edited"] },
    workflow_dispatch: null,
  });
  assert.deepEqual(reviewInteraction.permissions, {});
  assert.equal(
    interactionJob.if,
    "${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}",
  );
  assert.equal(interactionJob["runs-on"], "ubuntu-24.04");
  assert.equal(interactionJob.env.RR_RUNTIME_REF, reviewRouterRevision);
  assert.equal(interactionJob.env.REVIEWROUTER_RUNTIME_CONFIG_MODE, "oidc");
  assert.equal(interactionJob.env.REVIEWROUTER_COMMENT_TOKEN_MODE, "app-oidc");
  assert.equal(interactionJob.env.REVIEW_ROUTER_MEMORY_ENABLED, "true");
  const interactionCheckout = interactionJob.steps.find(
    ({ name }) => name === "Checkout ReviewRouter interaction runtime",
  );
  const interactionNodeSetup = interactionJob.steps.find(
    ({ name }) => name === "Setup Node.js",
  );
  const interactionPreflight = interactionJob.steps.find(
    ({ name }) => name === "Preflight ReviewRouter interaction",
  );
  const interactionAuthRestore = interactionJob.steps.find(
    ({ name }) => name === "Restore Codex subscription auth for discussion replies",
  );
  const interactionRun = interactionJob.steps.find(
    ({ name }) => name === "Run ReviewRouter interaction",
  );
  assert.equal(
    interactionCheckout.uses,
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  );
  assert.equal(interactionCheckout.with.repository, "777genius/review-router");
  assert.equal(interactionCheckout.with.ref, "${{ env.RR_RUNTIME_REF }}");
  assert.equal(interactionCheckout.with["persist-credentials"], false);
  assert.equal(
    interactionNodeSetup.uses,
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  );
  assert.equal(interactionPreflight.env.REVIEW_ROUTER_MODE, "interaction-preflight");
  assert.equal(interactionPreflight.run, "node .reviewrouter-runtime/dist/index.js");
  assert.equal(
    interactionAuthRestore.env.CODEX_AUTH_JSON,
    "${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
  );
  assert.match(interactionAuthRestore.run, /chmod 600 "\$CODEX_HOME\/auth\.json"/u);
  assert.equal(interactionRun.env.REVIEW_ROUTER_MODE, "interaction");
  assert.equal(interactionRun.run, "node .reviewrouter-runtime/dist/index.js");
  assert.deepEqual(Object.keys(interactionJob).toSorted(), [
    "env",
    "if",
    "name",
    "permissions",
    "runs-on",
    "steps",
  ]);
  assert.match(
    reviewInteractionSource,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/u,
  );
  assert.match(reviewInteractionSource, /\.reviewrouter-runtime\/dist\/index\.js/u);
  assert.match(reviewInteractionSource, /CODEX_HOME\/auth\.json/u);
  assert.doesNotMatch(reviewInteractionSource, /pnpm (?:install|action-setup)/u);
}

function assertExactReleaseRunBinding(attestation, release, ci) {
  const jobTimeoutSeconds =
    release.jobs["attest-release-pr"]["timeout-minutes"] * 60;
  const primaryDeadlineSeconds = 2100;
  const finalVerificationSeconds = 60;

  assert.equal(jobTimeoutSeconds, 2400);
  assert.match(attestation.run, /deadline=\$\(\(SECONDS \+ 2100\)\)/u);
  assert.match(attestation.run, /actions\/workflows\/ci\.yml\/dispatches/u);
  assert.match(attestation.run, /-F return_run_details=true/u);
  assert.match(attestation.run, /\.workflow_run_id \/\/ ""/u);
  assert.match(
    attestation.run,
    /expected_run_url="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{bound_run_id\}"/u,
  );
  assert.match(attestation.run, /bound_run_url.*expected_run_url/su);
  assert.match(attestation.run, /actions\/runs\/\$\{bound_run_id\}"/u);
  assert.equal((attestation.run.match(/run_id.*bound_run_id/gu) ?? []).length, 2);
  assert.equal(
    (attestation.run.match(/run_path.*\.github\/workflows\/ci\.yml/gu) ?? [])
      .length,
    2,
  );
  assert.match(attestation.run, /run_event.*bound_run_event/su);
  assert.match(attestation.run, /run_head_branch.*changeset-release\/main/su);
  assert.match(attestation.run, /run_head_sha.*head_sha/su);
  assert.match(attestation.run, /bound_run_attempt.*"1"/su);
  assert.match(
    attestation.run,
    /actions\/runs\/\$\{bound_run_id\}\/attempts\/\$\{bound_run_attempt\}\/jobs/u,
  );
  assert.match(attestation.run, /if ! jobs="\$\(gh api/u);
  assert.match(attestation.run, /\[length, first\.status \/\/ "missing"\]/u);
  assert.match(attestation.run, /job_count > 1/u);
  assert.match(attestation.run, /job_count == 0.*run_status.*completed/su);
  assert.match(attestation.run, /run_conclusion.*success/su);
  assert.match(attestation.run, /final_bound_run="\$\(gh api/u);
  assert.match(attestation.run, /final_run_status.*completed/su);
  assert.match(attestation.run, /final_run_conclusion.*success/su);
  assert.match(
    attestation.run,
    /final_verification_deadline=\$\(\(SECONDS \+ 60\)\)/u,
  );
  assert.match(
    attestation.run,
    /while \(\( SECONDS < final_verification_deadline \)\); do/u,
  );
  assert.ok(
    attestation.run.lastIndexOf("deadline=$((SECONDS + 2100))") <
      attestation.run.lastIndexOf(
        "final_verification_deadline=$((SECONDS + 60))",
      ),
  );
  assert.ok(
    primaryDeadlineSeconds + finalVerificationSeconds <= jobTimeoutSeconds,
  );
  assert.ok(
    attestation.run.lastIndexOf("final_bound_run") <
      attestation.run.lastIndexOf('post_status "${ci_contexts[index]}" success'),
  );
  assert.doesNotMatch(attestation.run, /baseline_run_id/u);
  assert.doesNotMatch(attestation.run, /sort_by\(\.id\) \| first/u);
  assert.doesNotMatch(attestation.run, /commits\/\$\{head_sha\}\/check-runs/u);
  assert.doesNotMatch(attestation.run, /sort_by\(\.id\) \| last/u);
  assert.ok(
    release.jobs["attest-release-pr"]["timeout-minutes"] >=
      ci.jobs["dependency-review"]["timeout-minutes"] +
        ci.jobs["macos-qualification"]["timeout-minutes"] +
        10,
  );
}

function exactPullRequestRun(overrides = {}) {
  const repository = "agent-teams-ai/engineering-foundation";
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  return {
    id: 123,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_branch: "changeset-release/main",
    head_sha: headSha,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/${repository}/actions/runs/123`,
    head_repository: { full_name: repository },
    pull_requests: [
      {
        number: 127,
        head: { ref: "changeset-release/main", sha: headSha },
        base: { ref: "main", sha: baseSha },
      },
    ],
    ...overrides,
  };
}

const exactRunExpectation = {
  repository: "agent-teams-ai/engineering-foundation",
  serverUrl: "https://github.com",
  branch: "changeset-release/main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  pullRequestNumber: 127,
};

test("release CI selection reuses only one exact attempt-1 pull request run", () => {
  assert.deepEqual(
    selectReleaseCiRun({ workflow_runs: [exactPullRequestRun()] }, exactRunExpectation),
    {
      id: 123,
      event: "pull_request",
      url: "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123",
    },
  );
  for (const incompatible of [
    { run_attempt: 2 },
    { status: "completed", conclusion: "action_required" },
    { event: "workflow_dispatch" },
    { head_repository: { full_name: "attacker/fork" } },
    { html_url: "https://example.test/actions/runs/123" },
    { pull_requests: [] },
    {
      pull_requests: [
        {
          number: 127,
          head: { ref: "changeset-release/main", sha: "b".repeat(40) },
          base: { ref: "main", sha: "c".repeat(40) },
        },
      ],
    },
  ]) {
    assert.equal(
      selectReleaseCiRun(
        { workflow_runs: [exactPullRequestRun(incompatible)] },
        exactRunExpectation,
      ),
      null,
    );
  }
  assert.throws(
    () =>
      selectReleaseCiRun(
        {
          workflow_runs: [
            exactPullRequestRun(),
            exactPullRequestRun({
              id: 124,
              html_url:
                "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/124",
            }),
          ],
        },
        exactRunExpectation,
      ),
    /Multiple exact attempt-1/u,
  );
});

test("CI concurrency isolates pull request checks from attester dispatches", async () => {
  const ci = await workflow("ci.yml");
  const codeql = await workflow("codeql.yml");
  const requiredLifecycleEvents = [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ];
  const readyPullRequestCondition =
    "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}";
  assert.deepEqual(ci.on.pull_request.types, requiredLifecycleEvents);
  assert.deepEqual(codeql.on.pull_request.types, requiredLifecycleEvents);
  assert.equal(ci.jobs["dependency-review"].if, undefined);
  assert.equal(ci.jobs["linux-static"].if, readyPullRequestCondition);
  assert.equal(codeql.jobs.analyze.if, readyPullRequestCondition);
  assert.equal(
    ci.concurrency.group,
    "foundation-ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}",
  );
  assert.equal(ci.concurrency["cancel-in-progress"], true);
});

test("release pipeline keeps hosted review separate from generated-diff attestation", async () => {
  const release = await workflow("release.yml");
  const ci = await workflow("ci.yml");
  const review = await workflow("reviewrouter-codex.yml");
  const reviewInteraction = await workflow("reviewrouter-interaction.yml");
  const reviewInteractionSource = await readFile(
    join(repositoryRoot, ".github", "workflows", "reviewrouter-interaction.yml"),
    "utf8",
  );
  const releaseJob = release.jobs.release;
  const releaseBinding = releaseJob.steps.find(({ id }) => id === "release-pr");
  const attestationSteps = release.jobs["attest-release-pr"].steps;
  const attestation = attestationSteps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );
  assert.equal(releaseJob["timeout-minutes"], 30);
  const attestationIndex = attestationSteps.indexOf(attestation);
  const attestationPnpmSetupIndex = attestationSteps.findIndex(
    ({ uses }) => uses?.startsWith("pnpm/action-setup@"),
  );
  const attestationNodeSetupIndex = attestationSteps.findIndex(
    ({ uses }) => uses?.startsWith("actions/setup-node@"),
  );
  const attestationInstallIndex = attestationSteps.findIndex(
    ({ run }) => run === "pnpm install --frozen-lockfile --ignore-scripts",
  );

  assert.equal(releaseJob.outputs.pullRequestNumber, "${{ steps.release-pr.outputs.number }}");
  assert.equal(releaseJob.outputs.pullRequestBaseSha, "${{ steps.release-pr.outputs.base_sha }}");
  assert.equal(releaseJob.outputs.pullRequestHeadSha, "${{ steps.release-pr.outputs.head_sha }}");
  assert.equal(releaseBinding.env.PROCESSED_MAIN_SHA, "${{ github.sha }}");
  assert.match(releaseBinding.run, /deadline=\$\(\(SECONDS \+ 30\)\)/u);
  assert.match(releaseBinding.run, /git ls-remote --refs origin/u);
  assert.match(releaseBinding.run, /check-release-pr-freshness\.mjs/u);
  assert.match(releaseBinding.run, /check-release-pr-files\.mjs/u);
  assert.match(releaseBinding.run, /stable_branch_head_sha/u);
  assert.match(releaseBinding.run, /stable_current_main_sha/u);
  assert.ok(
    releaseBinding.run.indexOf("check-release-pr-freshness.mjs") <
      releaseBinding.run.indexOf("printf 'number=%s\\n'"),
  );
  assert.ok(
    releaseBinding.run.indexOf("check-release-pr-files.mjs") <
      releaseBinding.run.indexOf("printf 'number=%s\\n'"),
  );
  assert.deepEqual([releaseJob.permissions["id-token"], releaseJob.permissions.contents, releaseJob.steps.find(({ run }) => run?.startsWith("pnpm install"))?.run, releaseJob.steps.find((step) => step.id === "changesets").with.createGithubReleases], ["write", "write", "pnpm install --frozen-lockfile --ignore-scripts", false]);
  assert.match(attestation.run, /node scripts\/check-release-pr-files\.mjs/u);
  assert.ok(attestationPnpmSetupIndex > 0);
  assert.ok(attestationNodeSetupIndex > attestationPnpmSetupIndex);
  assert.ok(attestationInstallIndex > attestationNodeSetupIndex);
  assert.ok(attestationIndex > attestationInstallIndex);
  assert.equal(
    attestationSteps[attestationPnpmSetupIndex].uses,
    "pnpm/action-setup@008330803749db0355799c700092d9a85fd074e9",
  );
  assert.equal(
    attestationSteps[attestationNodeSetupIndex].uses,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  );
  assert.equal(
    attestationSteps[attestationNodeSetupIndex].with["node-version-file"],
    ".node-version",
  );
  const changesetCoverage = ci.jobs["linux-static"].steps.find(
    ({ name }) => name === "Validate package Changeset coverage",
  );
  assert.equal(changesetCoverage.run, "pnpm changeset:coverage");
  assert.match(changesetCoverage.if, /pull_request[\s\S]*changeset-release\/main/u);
  assert.match(
    changesetCoverage.if,
    /head\.repo\.full_name != github\.repository/u,
  );
  assert.equal(changesetCoverage.env.FOUNDATION_CHANGESET_BASE_SHA, "${{ github.event.pull_request.base.sha }}");
  assert.equal(ci.jobs["linux-static"].steps.find(({ run }) => run === "pnpm release-owned-files:check").env.FOUNDATION_PR_HEAD_REPOSITORY, "${{ github.event.pull_request.head.repo.full_name }}");
  assert.equal(
    attestation.env.EXPECTED_RELEASE_BASE_SHA,
    "${{ needs.release.outputs.pullRequestBaseSha }}",
  );
  assert.equal(
    attestation.env.EXPECTED_RELEASE_HEAD_SHA,
    "${{ needs.release.outputs.pullRequestHeadSha }}",
  );
  assert.equal(attestation.env.PROCESSED_MAIN_SHA, "${{ github.sha }}");
  assert.equal(
    (attestation.run.match(/check-release-pr-freshness\.mjs/gu) ?? []).length,
    2,
  );
  assert.equal(
    (attestation.run.match(/git\/ref\/heads\/main/gu) ?? []).length,
    2,
  );
  assert.match(attestation.run, /--arg expectedHeadSha "\$\{head_sha\}"/u);
  assert.equal(
    (attestation.run.match(/--arg expectedBaseSha/gu) ?? []).length,
    2,
  );
  assert.equal(
    (attestation.run.match(/--arg expectedPullRequestNumber/gu) ?? []).length,
    2,
  );
  assert.match(attestation.run, /--base "\$\{base_sha\}" --head "\$\{head_sha\}"/u);
  assert.match(attestation.run, /selection_deadline=\$\(\(SECONDS \+ 30\)\)/u);
  assert.match(attestation.run, /select-release-ci-run\.mjs/u);
  assert.match(attestation.run, /-f event=pull_request/u);
  assert.match(attestation.run, /-f head_sha="\$\{head_sha\}"/u);
  assert.match(
    attestation.run,
    /if ! candidate_runs=.*SECONDS >= selection_deadline.*break.*sleep 5.*continue/su,
  );
  assert.ok(
    attestation.run.indexOf("select-release-ci-run.mjs") <
      attestation.run.indexOf("actions/workflows/ci.yml/dispatches"),
  );
  assert.match(attestation.run, /if \[\[ -z "\$\{bound_run_id\}" \]\]; then/u);
  assert.match(attestation.run, /run_head_repository.*GITHUB_REPOSITORY/su);
  assert.equal((attestation.run.match(/pull_request_count\}" != "0"[\s\S]*?pull_request_count\}" != "1"/gu) ?? []).length, 2);
  assert.match(attestation.run, /run_pull_request_base_sha.*base_sha/su);
  assert.match(attestation.run, /final_run_pull_request_base_sha.*base_sha/su);
  assert.ok(
    attestation.run.lastIndexOf("check-release-pr-freshness.mjs") <
      attestation.run.lastIndexOf('post_status "${ci_contexts[index]}" success'),
  );
  assert.doesNotMatch(attestation.run, /ReviewGate|release_gate_context/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-release\.yml/u);
  assert.doesNotMatch(attestation.run, /\.context == "ReviewRouter"/u);
  assert.doesNotMatch(attestation.run, /post_status "ReviewRouter"/u);
  assert.match(
    attestation.run,
    /ci_contexts=\(check windows-check macos-qualification\)/u,
  );
  assertExactReleaseRunBinding(attestation, release, ci);
  assert.match(attestation.run, /for context in "\$\{ci_contexts\[@\]\}"/u);
  assert.equal(
    release.jobs["attest-release-pr"].permissions.actions,
    "write",
  );
  assert.equal(review.on.workflow_dispatch, undefined);
  assert.deepEqual(review.on.pull_request_target.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "converted_to_draft",
  ]);
  assert.equal(review.jobs["codex-review"].with.workflow_schema_version, 4);
  assert.match(review.jobs["codex-review"].if, /pull_request_target/u);
  assert.match(review.jobs["codex-review"].if, /user\.type != 'Bot'/u);
  assert.equal(
    review.jobs["codex-review"].secrets.CODEX_AUTH_JSON,
    "${{ secrets." + reviewRouterSecretName + " }}",
  );
  assertReviewRouterInteractionRuntime(
    reviewInteraction,
    reviewInteractionSource,
  );
});

test("release publishing requires real Buf and hermetic registry qualification", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const coverageRunner = await readFile(
    join(repositoryRoot, "scripts", "run-test-coverage.mjs"),
    "utf8",
  );
  const coverageManifestPath = join(repositoryRoot, "tests", "manifests", "coverage.v1.json");
  const coverageManifest = JSON.parse(await readFile(coverageManifestPath, "utf8"));
  for (const threshold of ["lines", "branches", "functions"]) {
    assert.ok(coverageManifest.thresholds[threshold] > 0);
    assert.match(coverageRunner, new RegExp(`config\\.thresholds\\.${threshold}`, "u"));
  }
  assert.match(manifest.scripts.check, /pnpm test:coverage:built/u);
  const ci = await workflow("ci.yml");
  assert.match(
    manifest.scripts["release:publish"],
    /registry-install-e2e:built/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /buf-qualification:e2e:built/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /published-compatibility:e2e/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /node scripts\/release-publish\.mjs/u,
  );
  assert.match(
    manifest.scripts["release:publish"],
    /release-publish\.mjs && pnpm public-docs-release:e2e$/u,
  );
  assert.equal(
    manifest.scripts["public-docs-release:e2e"],
    "node scripts/public-docs-release-e2e.mjs",
  );
  assert.match(manifest.scripts["release:publish"], /^pnpm build &&/u);
  assert.doesNotMatch(
    manifest.scripts["release:publish"],
    /(?:^|&&\s*)(?:changeset publish|pnpm check)(?:\s|&&|$)/u,
  );
  assert.equal(
    manifest.scripts["registry-install-e2e:built"],
    "node scripts/registry-install-e2e.mjs",
  );
  assert.equal(ci.jobs["linux-registry"].steps.at(-1).run, "pnpm registry-install-e2e");
  const windowsRegistryCommands = ci.jobs["windows-registry"].steps
    .map((step) => step.run)
    .filter((command) => command !== undefined);
  assert.deepEqual(windowsRegistryCommands.slice(-3), [
    "pnpm build",
    "node scripts/prepare-package.mjs",
    "pnpm registry-install-e2e:built",
  ]);
  assert.equal(
    ci.jobs["windows-package"].steps.at(-1).run,
    "pnpm package:check",
  );
  assert.ok(ci.jobs["windows-check"].needs.includes("windows-package"));
  assert.ok(ci.jobs["windows-check"].needs.includes("windows-registry"));
  assert.equal(
    manifest.scripts["published-compatibility:e2e"],
    "node scripts/published-compatibility-e2e.mjs",
  );
  for (const name of ["linux-published", "windows-published"]) {
    const step = ci.jobs[name].steps.at(-1);
    assert.deepEqual([step.run, step.env], [
      "pnpm published-compatibility:e2e", { GH_TOKEN: "${{ github.token }}" },
    ]);
  }
  const windowsTestA = ci.jobs["windows-test-a"];
  const windowsTestB = ci.jobs["windows-test-b"];
  assert.deepEqual(
    [windowsTestA.name, windowsTestA.steps.at(-1).run],
    ["windows-test-a", "pnpm test:shard:built -- --shards 1,4"],
  );
  assert.deepEqual(
    [windowsTestB.name, windowsTestB.steps.at(-1).run],
    ["windows-test-b", "pnpm test:shard:built -- --shards 2,3"],
  );
  assert.deepEqual(ci.jobs.check.needs, [
    "dependency-review",
    "linux-static",
    "linux-test-1",
    "linux-test-2",
    "linux-test-3",
    "linux-test-4",
    "linux-coverage",
    "linux-package",
    "linux-registry",
    "linux-published",
  ]);
  assert.equal(
    ci.jobs.check.if,
    "${{ always() && (github.event_name != 'pull_request' || github.event.pull_request.draft == false) }}",
  );
  assert.match(ci.jobs.check.steps[0].uses, /^re-actors\/alls-green@[a-f0-9]{40}$/u);
});

test("release diff policy permits only version and generated changelog changes", () => {
  const evidence = {
    baseManifest: { name: "@agent-teams/engineering-foundation", version: "0.4.1" },
    headManifest: { name: "@agent-teams/engineering-foundation", version: "0.5.0" },
    baseChangelog: "# Changelog\n\n## 0.4.1\n",
    headChangelog: "# Changelog\n\n## 0.5.0\n\nNew capability.\n\n## 0.4.1\n",
  };

  assert.deepEqual(releasePullRequestContentViolations(evidence), []);
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, scripts: { prepublishOnly: "steal-secrets" } },
    })[0],
    /only package\.json version/u,
  );
  assert.match(
    releasePullRequestContentViolations({ ...evidence, headChangelog: "rewritten" })[0],
    /only insert/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.4.0" },
    })[0],
    /valid new version/u,
  );
});

test("release diff policy validates Changesets prerelease consumption", () => {
  const basePrereleaseState = {
    mode: "pre",
    tag: "rc",
    initialVersions: { "@agent-teams/engineering-foundation": "0.15.0" },
    changesets: [],
  };
  const evidence = {
    baseManifest: { name: "@agent-teams/engineering-foundation", version: "0.15.0" },
    headManifest: {
      name: "@agent-teams/engineering-foundation",
      version: "0.16.0-rc.0",
    },
    baseChangelog: "# Changelog\n\n## 0.15.0\n",
    headChangelog: "# Changelog\n\n## 0.16.0-rc.0\n\nNew capability.\n\n## 0.15.0\n",
    basePrereleaseState,
    headPrereleaseState: {
      ...basePrereleaseState,
      changesets: ["durable-document-writer"],
    },
  };

  assert.deepEqual(releasePullRequestContentViolations(evidence), []);
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headPrereleaseState: { ...evidence.headPrereleaseState, tag: "beta" },
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.16.0-beta.0" },
    }).join("\n"),
    /matching prerelease state/u,
  );
  const withDocsInitialVersion = {
    ...evidence,
    docsBootstrapInitialVersionAddition: true,
    headPrereleaseState: { ...evidence.headPrereleaseState, initialVersions: {
      ...evidence.headPrereleaseState.initialVersions,
      "@agent-teams/docs-protocol": "0.0.0",
    } },
  };
  assert.deepEqual(releasePullRequestContentViolations(withDocsInitialVersion), []);
  const withMcpInitialVersion = {
    ...evidence,
    initialVersionAdditions: ["@agent-teams/docs-protocol-mcp"],
    headPrereleaseState: { ...evidence.headPrereleaseState, initialVersions: {
      ...evidence.headPrereleaseState.initialVersions,
      "@agent-teams/docs-protocol-mcp": "0.0.0",
    } },
  };
  assert.deepEqual(releasePullRequestContentViolations(withMcpInitialVersion), []);
  assert.match(
    releasePullRequestContentViolations({
      ...withMcpInitialVersion,
      initialVersionAdditions: [],
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...withDocsInitialVersion,
      docsBootstrapInitialVersionAddition: false,
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...withDocsInitialVersion,
      headPrereleaseState: {
        ...withDocsInitialVersion.headPrereleaseState,
        initialVersions: {
          ...withDocsInitialVersion.headPrereleaseState.initialVersions,
          unexpected: "1.0.0",
        },
      },
    }).join("\n"),
    /only append consumed Changesets/u,
  );
  const nextPrerelease = {
    ...evidence,
    baseManifest: { ...evidence.headManifest, version: "0.16.0-rc.0" },
    headManifest: { ...evidence.headManifest, version: "0.16.0-rc.1" },
  };
  assert.deepEqual(releasePullRequestContentViolations(nextPrerelease), []);
  assert.match(
    releasePullRequestContentViolations({
      ...nextPrerelease,
      headManifest: { ...nextPrerelease.headManifest, version: "0.16.0-rc.01" },
    }).join("\n"),
    /valid new version/u,
  );
});

test("release diff policy accepts only an exact prerelease exit", () => {
  const basePrereleaseState = {
    mode: "exit",
    tag: "rc",
    initialVersions: { "@agent-teams/engineering-foundation": "0.15.0" },
    changesets: ["durable-document-writer"],
  };
  const evidence = {
    baseManifest: {
      name: "@agent-teams/engineering-foundation",
      version: "0.16.0-rc.0",
    },
    headManifest: {
      name: "@agent-teams/engineering-foundation",
      version: "0.16.0",
    },
    baseChangelog: "# Changelog\n\n## 0.16.0-rc.0\n",
    headChangelog:
      "# Changelog\n\n## 0.16.0\n\nStable release.\n\n## 0.16.0-rc.0\n",
    basePrereleaseState,
    headPrereleaseState: undefined,
  };

  assert.deepEqual(releasePullRequestContentViolations(evidence), []);
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      headManifest: { ...evidence.headManifest, version: "0.16.1" },
    }).join("\n"),
    /exact stable version/u,
  );
  assert.match(
    releasePullRequestContentViolations({
      ...evidence,
      basePrereleaseState: { ...basePrereleaseState, mode: "pre" },
    }).join("\n"),
    /preserve a valid Changesets prerelease state/u,
  );
});

test("release diff policy accepts only normalized Changesets output", () => {
  const validFiles = [
    { filename: ".changeset/portable-agent-workflow.md", status: "removed" },
    { filename: "architecture/contracts/protobuf/control.json", status: "modified" },
    { filename: "architecture/contracts/events.yaml", status: "added" },
    { filename: "architecture/public-api/engineering-foundation.json", status: "modified" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];

  assert.deepEqual(releasePullRequestFileViolations(validFiles), []);
  assert.match(
    releasePullRequestFileViolations([
      ...validFiles,
      { filename: "packages/engineering-foundation/src/backdoor.ts", status: "added" },
    ])[0],
    /forbidden change/u,
  );
  assert.match(
    releasePullRequestFileViolations([
      ...validFiles,
      { filename: "architecture/contracts/../escape.json", status: "added" },
    ])[0],
    /forbidden change/u,
  );
  assert.match(
    releasePullRequestFileViolations(
      validFiles.filter(({ filename }) => !filename.endsWith("package.json")),
    )[0],
    /must modify/u,
  );
});

test("release diff policy accepts normalized prerelease Changesets output", () => {
  const validFiles = [
    { filename: ".changeset/pre.json", status: "modified" },
    { filename: "architecture/public-api/engineering-foundation.json", status: "modified" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];

  assert.deepEqual(releasePullRequestFileViolations(validFiles), []);
  assert.match(
    releasePullRequestFileViolations(
      validFiles.map((file) =>
        file.filename === ".changeset/pre.json" ? { ...file, status: "added" } : file,
      ),
    ).join("\n"),
    /forbidden change/u,
  );
});

test("release diff policy narrowly allows exit state deletion and rejects private noise", async () => {
  const exitFiles = [
    { filename: ".changeset/durable-document-writer.md", status: "removed" },
    { filename: ".changeset/pre.json", status: "removed" },
    { filename: "architecture/public-api/engineering-foundation.json", status: "modified" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];

  assert.deepEqual(
    releasePullRequestFileViolations(exitFiles, { prereleaseExit: true }),
    [],
  );
  assert.match(
    releasePullRequestFileViolations(exitFiles).join("\n"),
    /forbidden change: \.changeset\/pre\.json/u,
  );
  assert.match(
    releasePullRequestFileViolations(
      [
        ...exitFiles,
        { filename: "spikes/source-dependency-parser/package.json", status: "modified" },
      ],
      { prereleaseExit: true },
    ).join("\n"),
    /forbidden change: spikes\/source-dependency-parser\/package\.json/u,
  );

  const config = JSON.parse(
    await readFile(join(repositoryRoot, ".changeset", "config.json"), "utf8"),
  );
  assert.deepEqual(config.privatePackages, { version: true, tag: false });
  assert.deepEqual(config.ignore, []);
});

test("release diff policy requires complete pairs from the promoted public catalog", () => {
  const validFiles = [
    { filename: ".changeset/unified-docs-protocol.md", status: "removed" },
    { filename: "packages/engineering-foundation/CHANGELOG.md", status: "modified" },
    { filename: "packages/engineering-foundation/package.json", status: "modified" },
  ];
  assert.deepEqual(releasePullRequestFileViolations(validFiles), []);
  assert.match(
    releasePullRequestFileViolations(
      [...validFiles, { filename: "packages/docs-protocol/package.json", status: "modified" }],
    ).join("\n"),
    /must modify packages\/docs-protocol\/CHANGELOG\.md/u,
  );
});

test("release diff policy reads piped GitHub evidence through portable stdin", async () => {
  assert.equal(
    await readStreamText(Readable.from([Buffer.from('[{"filename":'), '"safe"}]'])),
    '[{"filename":"safe"}]',
  );
});
