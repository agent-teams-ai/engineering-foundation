# ADR-0005: Repository Security Baseline

Status: Proposed

Date: 2026-08-02

Decision owner: Product owner

## Context

Reusable tooling repositories execute third-party Actions and publish packages,
so workflow and package security cannot depend on reviewers remembering every
rule.

## Proposed decision

Adopt the closed-world repository security capability described in
[Repository security baseline](../security/repository-security-baseline.md), with
full-SHA actions, least privilege, dependency review, SBOM generation, npm
provenance, and real tarball canary checks.

## Consequences

New workflows are governed automatically. Write-capable jobs require exact
consumer-owned declarations, and package supply-chain evidence is tested before
publication.
