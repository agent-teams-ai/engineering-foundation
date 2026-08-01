# Repository Security Baseline

Status: Implemented; ADR-0005 is proposed.

`repository.security-baseline` discovers every regular YAML file in the declared
workflow directory. Symlinks, unsupported entries, missing required workflows,
and malformed YAML are invalid input rather than partial success.

## Workflow controls

- every external action and reusable workflow uses a full 40-character commit
  SHA; local actions are allowed, and container actions require a SHA-256 digest;
- root `permissions` is an explicit object containing only `read` or `none`;
- a job can request `write` only when consumer policy declares its exact workflow,
  job ID, and complete permission map;
- stale privilege declarations, `write-all`, `pull_request_target`, and direct
  `${{ github.event.* }}` interpolation inside shell scripts fail;
- the declared workflows must run pinned Dependency Review and Anchore SBOM
  actions.

## Package controls

Every declared publishable package enables npm provenance and uses a narrow
`files` allowlist. Root, parent, recursive, source, test, Git, environment, and
known local-auth paths are prohibited. The package E2E test packs and extracts
the real tarball, proves required files, rejects forbidden paths, and searches
all packed content for a source-owned secret canary.

Dependency Review blocks newly introduced vulnerable dependencies. Anchore
generates an SPDX JSON SBOM in Linux CI. npm Trusted Publishing provides the
package publication provenance. These are independent controls: an SBOM lists
components, while provenance identifies the build and publisher.
