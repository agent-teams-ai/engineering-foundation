# Executable Specifications

Status: Implemented; consumer activation is explicit.

`quality.executable-specifications` proves that a consumer's executable
specification artifacts are connected by a strict, static contract. It does not
run generators, property tests, mutation tests, state-model tests, package
scripts, or consumer code, and it does not claim that those gates passed.

## Ownership

Foundation owns the versioned configuration and catalog schemas, strict JSON
Schema Draft 2020-12 inspection, repository containment, artifact connectivity,
stable diagnostics, and deterministic digests. The consumer owns all domain
facts, specification documents, schemas, generated types, evaluators,
properties, mutation setup, package scripts, owner documents, ADRs, XState
models, adapters, traces, and diagrams.

The capability has no XState runtime dependency. `kind: xstate` describes an
artifact topology only. Foundation reads those files as bounded evidence and
never imports them.

## Configuration

Enable the capability explicitly:

```yaml
schemaVersion: 1
project:
  id: consumer-repository
capabilities:
  quality.executable-specifications:
    configPath: architecture/foundation/executable-specifications.yaml
```

The capability configuration points to one consumer-owned JSON catalog:

```yaml
schemaVersion: 1
catalogPath: architecture/specifications/catalog.json
```

The catalog is JSON-first and validated by
`quality-executable-specification-catalog/v1`. Each specification declares:

- a unique normalized `id`, owner documents, and ADR references;
- a local schema set and JSON documents bound by absolute schema IDs;
- one generated type output per schema binding;
- distinct consumer scripts for type generation, property testing, and mutation
  testing;
- either `stateModel.kind: none` or an XState topology.

An XState topology requires at least two unique state axes, model, adapter,
trace, and diagram paths, plus a fourth distinct `spec-model` gate binding.
Every path is repository-relative, contained, regular, and symlink-free.
Generated output and model artifact paths cannot collide within or across
catalog entries or with Foundation/capability configuration, the catalog,
workspace/package manifests, schemas, documents, owner documents, or ADRs.
Path identity uses portable NFC and
case-folded comparison, so aliases that collide on macOS or Windows fail on
every platform.

## Validation semantics

Schema files must be JSON Schema Draft 2020-12 documents with unique absolute
fragment-free `$id` values. `$ref` and `$dynamicRef` targets must resolve inside
the declared local schema set. Documents are strict JSON files and each is
validated against its declared schema ID by the same Ajv inspection machinery
used by `contract.json-schema-releases`.

All authoritative JSON rejects comments, trailing commas, and duplicate object
keys at every nesting depth before schema validation. Duplicate keys are never
normalized with last-write-wins behavior.

Gate bindings name a workspace package and an existing non-empty package
script. Only the root package and packages selected by `pnpm-workspace.yaml`
are candidates. Foundation only confirms that the binding exists. Required CI
remains consumer-owned and must execute those scripts independently.

Topology validation runs before artifact or package I/O. Catalog v1 permits at
most 64 specifications, 32 schemas per specification, 64 documents, and 64
generated bindings, with at most 1024 unique artifact paths overall. One catalog
inspection uses one workspace manifest selection snapshot, caches each declared
artifact read, retains the 8 MiB per-file ceiling, and enforces a 32 MiB
aggregate byte budget across unique artifacts and selected package manifests.
Budget exhaustion fails the capability as invalid input without a partial pass.

Inspection order, diagnostics, schema-set digests, document-corpus digests, and
artifact digests are deterministic. Reports contain no timestamps, absolute
paths, commands, source excerpts, or script output.

## Adoption evidence

Before activation, the consumer should prove one passing catalog, invalid JSON
document rejection, remote-reference rejection, missing artifact and gate
diagnostics, duplicate binding rejection, symlink rejection, and the optional
XState topology if it is used. Activation must not fabricate placeholder
specifications merely to exercise the capability.
