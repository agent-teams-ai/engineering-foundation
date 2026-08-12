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

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reviewRouterInteractionRevision =
  "6b35091c824b1d4d5ee6bf8316121ed08d3e4861";

async function workflow(name) {
  return parseYaml(
    await readFile(join(repositoryRoot, ".github", "workflows", name), "utf8"),
  );
}

test("release pipeline keeps App review and a bounded generated-diff attestation", async () => {
  const release = await workflow("release.yml");
  const ci = await workflow("ci.yml");
  const review = await workflow("reviewrouter-codex.yml");
  const reviewInteraction = await workflow("reviewrouter-interaction.yml");
  const reviewInteractionSource = await readFile(
    join(repositoryRoot, ".github", "workflows", "reviewrouter-interaction.yml"),
    "utf8",
  );
  const reviewGate = await workflow("review-gate.yml");
  const reviewGateSource = await readFile(
    join(repositoryRoot, ".github", "workflows", "review-gate.yml"),
    "utf8",
  );
  const releaseJob = release.jobs.release;
  const releaseBinding = releaseJob.steps.find(({ id }) => id === "release-pr");
  const reviewGateSteps = reviewGate.jobs["review-gate"].steps;
  const attestationSteps = release.jobs["attest-release-pr"].steps;
  const attestation = attestationSteps.find(
    ({ name }) => name === "Dispatch and attest release pull request checks",
  );
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
  assert.deepEqual(reviewGate.on.workflow_run.workflows, ["ReviewRouter Codex OAuth"]);
  assert.match(
    reviewGateSource,
    /workflow_run: # zizmor: ignore\[dangerous-triggers\].*executes no PR content/u,
  );
  assert.equal(reviewGateSteps.length, 1);
  assert.equal(reviewGateSteps[0].uses, undefined);
  assert.equal(reviewGate.jobs["review-gate"].permissions.actions, "read");
  assert.equal(reviewGate.jobs["review-gate"].permissions["pull-requests"], "read");
  assert.equal(reviewGate.jobs["review-gate"].permissions.statuses, "write");
  assert.match(reviewGateSteps[0].run, /-f context="ReviewGate"/u);
  assert.match(reviewGateSteps[0].run, /\.context == "ReviewRouter"/u);
  assert.match(reviewGateSteps[0].run, /\.creator\.id == \$app_bot_id/u);
  assert.match(reviewGateSteps[0].run, /\.creator\.type == "Bot"/u);
  assert.match(
    reviewGateSteps[0].run,
    /Published a failing ReviewGate on pull request/u,
  );
  assert.doesNotMatch(
    reviewGateSteps[0].run,
    /\[\[ "\$\{gate_state\}" == "success" \]\]/u,
  );
  assert.equal(
    reviewGateSteps[0].env.REVIEWROUTER_APP_BOT_ID,
    "281702430",
  );
  assert.match(reviewGateSteps[0].run, /reviewrouter-codex\.yml/u);
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
  const changesetCoverage = ci.jobs.check.steps.find(
    ({ name }) => name === "Validate package Changeset coverage",
  );
  assert.equal(changesetCoverage.run, "pnpm changeset:coverage");
  assert.match(changesetCoverage.if, /pull_request[\s\S]*changeset-release\/main/u);
  assert.match(
    changesetCoverage.if,
    /head\.repo\.full_name != github\.repository/u,
  );
  assert.equal(
    changesetCoverage.env.FOUNDATION_CHANGESET_BASE_SHA,
    "${{ github.event.pull_request.base.sha }}",
  );
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
  assert.ok(
    attestation.run.lastIndexOf("check-release-pr-freshness.mjs") <
      attestation.run.lastIndexOf('post_status "${release_gate_context}" success'),
  );
  assert.match(attestation.run, /post_status "\$\{release_gate_context\}" success/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-codex\.yml/u);
  assert.doesNotMatch(attestation.run, /gh workflow run reviewrouter-release\.yml/u);
  assert.doesNotMatch(attestation.run, /\.context == "ReviewRouter"/u);
  assert.doesNotMatch(attestation.run, /post_status "ReviewRouter"/u);
  assert.match(
    attestation.run,
    /ci_contexts=\(check windows-check macos-qualification\)/u,
  );
  assert.equal(release.jobs["attest-release-pr"]["timeout-minutes"], 40);
  assert.match(attestation.run, /deadline=\$\(\(SECONDS \+ 2100\)\)/u);
  assert.ok(
    release.jobs["attest-release-pr"]["timeout-minutes"] >=
      ci.jobs["dependency-review"]["timeout-minutes"] +
        ci.jobs["macos-qualification"]["timeout-minutes"] +
        10,
  );
  assert.match(attestation.run, /for context in "\$\{ci_contexts\[@\]\}"/u);
  assert.equal(
    release.jobs["attest-release-pr"].permissions.actions,
    "write",
  );
  assert.equal(review.on.workflow_dispatch, undefined);
  assert.equal(review.jobs["codex-review"].with.workflow_schema_version, 2);
  assert.match(review.jobs["codex-review"].if, /user\.type != 'Bot'/u);
  assert.deepEqual(reviewInteraction.jobs.interaction.permissions, {
    actions: "write",
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
    reviewInteraction.jobs.interaction.if,
    "${{ github.event_name == 'workflow_dispatch' || ((github.event_name != 'issue_comment' || github.event.issue.pull_request) && github.event.comment.user.type != 'Bot') }}",
  );
  assert.equal(
    reviewInteraction.jobs.interaction.uses,
    `777genius/review-router/.github/workflows/reviewrouter-interaction-reusable.yml@${reviewRouterInteractionRevision}`,
  );
  assert.deepEqual(reviewInteraction.jobs.interaction.with, {
    runtime_ref: reviewRouterInteractionRevision,
    runtime_config_mode: "oidc",
    review_workflow_file: "reviewrouter-codex.yml",
    discussion_mode: "${{ vars.REVIEW_ROUTER_DISCUSSION_MODE || 'off' }}",
    discussion_model: "${{ vars.REVIEW_CODEX_MODEL || 'gpt-5.5' }}",
    discussion_reasoning_effort: "${{ vars.REVIEW_CODEX_EFFORT || 'xhigh' }}",
    discussion_max_per_pr: "${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_PR || '20' }}",
    discussion_max_per_thread: "${{ vars.REVIEW_ROUTER_DISCUSSION_MAX_PER_THREAD || '5' }}",
    discussion_timeout_seconds: "${{ vars.REVIEW_ROUTER_DISCUSSION_TIMEOUT_SECONDS || '60' }}",
  });
  assert.deepEqual(reviewInteraction.jobs.interaction.secrets, {
    REVIEW_ROUTER_LEDGER_KEY: "${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}",
    CODEX_AUTH_JSON: "${{ secrets.REVIEWROUTER_CODEX_AUTH_JSON }}",
  });
  assert.deepEqual(Object.keys(reviewInteraction.jobs.interaction).toSorted(), [
    "if",
    "name",
    "permissions",
    "secrets",
    "uses",
    "with",
  ]);
  assert.doesNotMatch(
    reviewInteractionSource,
    /actions\/(?:checkout|setup-node)@|\.reviewrouter-runtime|auth\.json|pnpm (?:install|action-setup)/u,
  );
});

test("release publishing requires real Buf and hermetic registry qualification", async () => {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
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
  assert.equal(
    manifest.scripts["registry-install-e2e:built"],
    "node scripts/registry-install-e2e.mjs",
  );
  assert.ok(
    ci.jobs.check.steps.some(
      (step) => step.run === "pnpm registry-install-e2e:built",
    ),
  );
  assert.equal(
    manifest.scripts["published-compatibility:e2e"],
    "node scripts/published-compatibility-e2e.mjs",
  );
  assert.ok(
    ci.jobs.check.steps.some(
      (step) => step.run === "pnpm published-compatibility:e2e",
    ),
  );
  assert.ok(
    ci.jobs["windows-check"].steps.some(
      (step) => step.run === "pnpm published-compatibility:e2e",
    ),
  );
});

test("release ReviewGate permits only version and generated changelog changes", () => {
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

test("release ReviewGate accepts only normalized Changesets output", () => {
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

test("release ReviewGate reads piped GitHub evidence through portable stdin", async () => {
  assert.equal(
    await readStreamText(Readable.from([Buffer.from('[{"filename":'), '"safe"}]'])),
    '[{"filename":"safe"}]',
  );
});
