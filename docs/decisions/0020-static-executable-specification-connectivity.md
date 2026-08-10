---
id: ADR-0020
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0020: Static Executable Specification Connectivity

Status: Accepted

Date: 2026-08-10

Decision owner: Product owner

## Context

Consumers need a portable way to prove that schemas, specification documents,
generated types, behavioral gates, and optional state-model evidence remain
connected. Running consumer code from Foundation would cross the ownership and
trust boundary, couple Foundation to test frameworks, and let a shared tool
make unsupported claims about domain behavior.

## Decision

Introduce the opt-in granular capability
`quality.executable-specifications`. A strict YAML configuration points to a
consumer-owned JSON catalog. Foundation validates its closed versioned shape,
inspects contained artifacts, and uses the existing strict Draft 2020-12 Ajv
machinery for local-only schema and document validation.

Each specification binds owner documents, ADRs, schemas, JSON documents, and
distinct consumer package scripts for property and mutation testing. Generated
type outputs and a distinct type-generation script are required together when
the consumer actually generates types and are both omitted for data-only
specifications. An optional
`stateModel.kind: xstate` topology requires at least two unique axes, model,
adapter, traces, diagram, and a distinct spec-model script binding.

Foundation never runs these scripts, imports the model, or claims gate success.
The consumer remains authoritative for domain facts, evaluators, properties,
mutation configuration, XState, and required CI. Foundation adds no XState
dependency.

## Consequences

- Catalog and report behavior remain deterministic, process-free, and local.
- Consumer scripts can change implementation without changing the Foundation
  contract while their stable bindings remain present.
- Schema/document inspection has one Ajv implementation shared with contract
  release validation.
- Installing the package does not activate the capability or create
  specification scaffolding.
- A future execution or qualification protocol requires a separate ADR and
  explicit provenance model.
