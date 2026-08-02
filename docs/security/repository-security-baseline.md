# Repository Security Baseline

Status: Accepted and implemented for publishing repositories by ADR-0005.

`repository.security-baseline` discovers every regular YAML file in the declared
workflow directory. Symlinks, unsupported entries, missing required workflows,
and malformed YAML are invalid input rather than partial success.

The combined profile applies to repositories that both run governed workflows
and publish at least one package. A non-publishing application does not invent a
package manifest to satisfy it; a future workflow-only profile is a separate
capability decision.

## Workflow controls

- every external action and reusable workflow uses a full 40-character commit
  SHA; local actions are allowed, and container actions require a SHA-256 digest;
- root `permissions` is an explicit object containing only `read` or `none`;
- a job can request `write` only when consumer policy declares its exact workflow,
  job ID, and complete permission map;
- stale privilege declarations, `write-all`, `pull_request_target`, and direct
  dot or bracket access to `github.event` and `github.head_ref` inside shell
  interpolation fail;
- the declared workflows must run pinned Dependency Review and Anchore SBOM
  actions on every pull request without job/step conditions or
  `continue-on-error`;
- Dependency Review cannot use advisory `warn-only` or an uninspected external
  config file; the SBOM action scans the repository root and retains its
  artifact.

## Package controls

Every declared publishable package enables npm provenance and uses a narrow,
literal `files` allowlist. Root, parent, glob, source, test, Git, environment,
and known local-auth paths are prohibited. This static capability does not
prove the produced tarball contents. A publishing consumer must separately run
a real tarball E2E check that proves required files, rejects forbidden paths,
and searches packed content for a source-owned secret canary before it may treat
package publication as qualified.

Dependency Review blocks newly introduced vulnerable dependencies. Anchore
generates an SPDX JSON SBOM in Linux CI. npm Trusted Publishing provides the
package publication provenance. These are independent controls: an SBOM lists
components, while provenance identifies the build and publisher.
