import { githubRequest, proveCommitCi } from "./npm-package-bootstrap-ci-proof.mjs";

// The command has no entry guard: starting this file always runs the proof, so a path quirk cannot turn it into a silent success.
try {
  const token = process.env.GH_TOKEN;
  if (token === undefined || token === "") {throw new Error("CI proof refused (CI_PROOF_INPUT): GH_TOKEN is not set.");}
  const proof = await proveCommitCi({
    repository: process.env.GITHUB_REPOSITORY ?? "", commit: process.argv[2] ?? "", request: githubRequest(token),
  });
  process.stdout.write(`CI proof: run ${String(proof.runId)} at ${proof.commit} is green for ${proof.contexts.join(", ")}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
