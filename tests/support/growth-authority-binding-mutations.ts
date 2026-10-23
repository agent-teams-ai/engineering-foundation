import type { DraftBinding } from "./growth-authority-test-ports.ts";
const d = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
export function grantBindingMutations(): [string, (value: { binding: DraftBinding }) => void][] {
  return [
    [
      "repository",
      (value) => {
        value.binding.target.repository.repositoryId = "124";
      },
    ],
    [
      "PR",
      (value) => {
        value.binding.target.pullRequestNumber = 45;
      },
    ],
    [
      "head",
      (value) => {
        value.binding.target.head.commit = "9".repeat(40);
      },
    ],
    [
      "base",
      (value) => {
        value.binding.target.base.commit = "9".repeat(40);
      },
    ],
    [
      "merge base",
      (value) => {
        value.binding.target.mergeBase.commit = "9".repeat(40);
      },
    ],
    [
      "merge result",
      (value) => {
        value.binding.target.evaluationKind = "merge-result";
      },
    ],
    [
      "verifier",
      (value) => {
        value.binding.verifier.immutableRevision = "9".repeat(40);
      },
    ],
    [
      "tool archive",
      (value) => {
        value.binding.tool.archiveDigest = d("f");
      },
    ],
    [
      "distribution",
      (value) => {
        value.binding.tool.distributionDigest = d("f");
      },
    ],
    [
      "lock",
      (value) => {
        value.binding.invocation.lockDigest = d("f");
      },
    ],
    [
      "changed policy",
      (value) => {
        value.binding.policy.configurationDigest = d("f");
      },
    ],
    [
      "narrowed scope",
      (value) => {
        value.binding.policy.scopeDigest = d("f");
      },
    ],
    [
      "missing command",
      (value) => {
        value.binding.policy.commandDigest = d("f");
      },
    ],
  ];
}
