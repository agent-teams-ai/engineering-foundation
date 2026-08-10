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
facts, specification documents, schemas, optional generated types, evaluators,
properties, mutation setup, package scripts, owner documents, ADRs, XState
models, adapters, traces, and diagrams.

The optional v1 state-model evidence profile is XState-shaped. The capability
has no XState runtime dependency and owns no XState runtime or domain semantics.
`kind: xstate` describes an artifact topology only; Foundation reads those files
as bounded evidence and never imports them. A different state-model formalism
requires a versioned contract extension with its own qualified evidence profile,
not a reinterpretation of the v1 fields as generic.

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
- zero or more generated type outputs bound to schemas;
- distinct consumer scripts for property testing and mutation testing, plus a
  type-generation script exactly when generated type outputs are declared;
- either `stateModel.kind: none` or an XState topology.

An XState topology requires an explicit, possibly empty list of unique
consumer-declared axis identifiers, model, adapter, trace, and diagram paths,
plus a fourth distinct `spec-model` gate binding. Foundation treats the
identifiers as opaque connectivity data; consumer gates must prove their
meaning, independence, and parity with the model and evidence.
Every path is repository-relative, contained, regular, and symlink-free.
Catalog and selected workspace-manifest paths use a conservative portable ASCII
contract. Each slash-separated segment may contain only letters, digits, `.`,
`_`, `@`, `+`, and `-`; it cannot end in dot or space or use a Windows device
basename such as `CON`, `NUL`, `COM1`, or `LPT1`, including before an extension.
Each ASCII path segment is limited to 255 characters.
Generated output and model artifact paths cannot collide within or across
catalog entries or with Foundation/capability configuration, the catalog,
workspace/package manifests, schemas, documents, owner documents, or ADRs.
Path identity uses ASCII case-insensitive comparison. Non-ASCII paths are
rejected instead of relying on platform-dependent Unicode normalization or case
folding. One collision map covers every declared role, reserved root input, and
selected workspace manifest before artifact or package-manifest reads.

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
Data-only specifications declare `generatedTypes: []` and must omit
`gateBindings.typeGeneration`; declaring generated outputs without that gate,
or declaring the gate without outputs, is invalid configuration.

Topology validation runs before artifact or package I/O. Catalog v1 permits at
most 64 specifications, 32 schemas per specification, 64 documents, and 64
generated bindings. A catalog may declare at most 1024 unique artifact paths,
and the combined set of declared artifacts plus selected workspace package
manifests may also contain at most 1024 paths. One catalog inspection uses one
workspace manifest selection snapshot, caches each declared artifact read,
limits JSON schemas and documents to 4 MiB each, limits other artifacts and
selected package manifests to 8 MiB each, and enforces a 32 MiB aggregate byte
budget across the complete unique corpus. Budget exhaustion fails the
capability as invalid input without a partial pass.

Inspection order, diagnostics, schema-set digests, document-corpus digests, and
artifact digests are deterministic. Reports contain no timestamps, absolute
paths, commands, source excerpts, or script output.

## Adoption evidence

Before activation, the consumer should prove one passing catalog, invalid JSON
document rejection, remote-reference rejection, missing artifact and gate
diagnostics, duplicate binding rejection, symlink rejection, and the optional
XState topology if it is used. Activation must not fabricate placeholder
specifications merely to exercise the capability.
