---
id: ADR-0005
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0005: Repository Security Baseline

Status: Accepted

Date: 2026-08-02

Decision owner: Product owner

## Context

Reusable tooling repositories execute third-party Actions and publish packages,
so workflow and package security cannot depend on reviewers remembering every
rule.

## Decision

Adopt the closed-world repository security capability described in
[Repository security baseline](../security/repository-security-baseline.md), with
full-SHA actions, least privilege, dependency review, SBOM generation, npm
provenance, and literal package allowlists. Real tarball canary verification is
a separate mandatory publication qualification gate; the static repository
capability must not claim that evidence.

This combined profile applies only to publishing repositories. A non-publishing
application does not fabricate package evidence; a future workflow-only profile
requires a separate capability decision.

## Consequences

New workflows are governed automatically. Write-capable jobs require exact
consumer-owned declarations, and package supply-chain evidence is tested before
publication.
