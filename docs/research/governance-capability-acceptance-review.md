# Governance capability acceptance review

Status: Complete; ADR-0003, ADR-0004, and ADR-0005 accepted

Date: 2026-08-02

## Evidence reviewed

PR #23 implemented and dogfooded the three governance capabilities. Linux,
Windows, dependency review, package, architecture, parser, and deterministic
capability tests passed. ReviewRouter did not start because its Codex session had
expired; that was reviewer unavailability rather than a code result. A manual
maintainer review then found and fixed API fingerprint, baseline ownership,
SemVer, multi-package validation, and required-workflow bypasses in commit
`5fa4139`.

The release review found two additional issues before `0.4.0` publication:

- multi-package baseline promotion was validation-first but not replay-safe if
  the process stopped after writing only some baselines;
- static package allowlists accepted glob and terminal parent-segment forms that
  were broader than the documented literal-path policy.

Both now have deterministic regression tests. The complete repository and packed
consumer checks remain the release gate for the exact release commit.

## Decisions

ADR-0003 accepts the 90-day maximum, exact location/rule binding, owner evidence,
and non-removable protected rule prefixes. The capability has one policy reason
to change and no consumer-domain dependency.

ADR-0004 accepts conservative released TypeScript compatibility, exact breaking-
change fingerprints, accepted-decision evidence, validation-first replayable
promotion, and release-owned baselines. Consumer activation still requires a
required PR mutation check because API comparison alone cannot prove Git branch
authority.

ADR-0005 accepts the closed-world profile only for repositories that publish a
package. Static workflow and manifest checks do not claim packed-artifact
evidence. A real tarball E2E check remains a separate mandatory publication gate;
non-publishing applications do not fabricate package evidence.

## Boundary verdict

Foundation remains development-only. Each capability owns a focused internal
model, ports, policies, adapters, schema, rules, and fixtures. Consumers own
applicability, paths, topology, exceptions, privileged jobs, and qualification
evidence. Package installation does not activate policy, and product or runtime
code never imports Foundation.
