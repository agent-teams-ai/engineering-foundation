---
id: ADR-0023
status: accepted
supersedes:
  - ADR-0022
superseded_by: []
---

# ADR-0023: Correct Document Authoring v1 Semantics

Status: Accepted

Date: 2026-08-13

Decision owner: Product owner

## Context

ADR-0022 established the correct ownership, trust, and mutation boundaries for
document authoring, but its pre-adoption v1 contracts did not define enough
information to compile every admitted placement. In particular, the Intent had
no explicit slug or destination, qualified identities had no consumer-declared
grammar, and several path, template, frontmatter, digest, partial-catalog, and
idempotency rules remained open to implementation interpretation.

Those omissions are unsafe. Two conforming compilers could derive different
paths or bytes from the same nominal input, and a writer could accidentally
treat a partial catalog or an unrelated matching file as an idempotent result.
Foundation is still before independent production adoption, so ADR-0019 permits
one coordinated correction of the current v1 instead of creating a speculative
parallel v2. ADR-0022 remains immutable historical evidence apart from its
governed lifecycle fields.

## Decision

1. Retain every boundary from ADR-0022: document authoring is a top-level,
   create-only Foundation mutation protocol, not a capability or scaffolding
   Recipe; consumers own document meaning; Plans and Receipts remain
   document-specific; and no generic mutation API or executable profile
   extension is exposed.
2. Correct the single current v1 contracts in place under ADR-0019 and update
   every known pre-adoption consumer in the same release wave. ADR-0023
   supersedes ADR-0022 only. It does not supersede or weaken ADR-0019.
3. `DocumentIntent` retains explicit `type`, `id`, `title`, `owner`, and
   `summary`, and adds optional bounded `slug` and `destination`. Presence is
   determined solely by the selected placement: a collection requires a slug
   exactly when its filename operator consumes one; a qualified leaf index
   forbids both; explicit placement requires destination and forbids slug.
   Unused path-affecting fields are invalid rather than ignored.
4. Close identity semantics. `adr-four-digits` accepts exactly
   `^ADR-[0-9]{4}$`; `open-decision-three-digits` accepts exactly
   `^OD-[0-9]{3}$`. A `qualified` identity declares
   `grammar: {prefixSegments,minSuffixSegments,maxSuffixSegments}`. Each dot
   segment matches `^[a-z][a-z0-9-]*$`; the identifier starts with the exact
   declared prefix and has a suffix count inside the declared inclusive bounds.
5. Freeze the locale-independent slug algorithm: normalize the title with
   Unicode NFKD, remove only combining marks U+0300 through U+036F, lowercase
   with JavaScript `toLowerCase`, replace every maximal run outside ASCII
   `[a-z0-9]` with `-`, and trim leading or trailing `-`. The result must match
   `^[a-z0-9]+(?:-[a-z0-9]+)*$`. If derivation is empty or a different slug is
   required, Intent supplies an explicit already-valid slug. This is a filename
   slug contract, not GitHub heading-anchor behavior.
6. Close placement semantics. `collection` joins its fixed directory with one
   of four closed filename operators: numeric ADR digits plus slug, full ID plus
   slug, slug alone, or literal `README.md`. `qualified-leaf-index` has one
   `root` and maps the qualified ID suffix one-to-one to path segments beneath
   that root plus its literal required basename. `explicit` accepts only an
   Intent destination below exactly one segment-boundary `allowedRoots` match,
   containing `requiredSegmentsInOrder` as one contiguous segment sequence and
   ending in the literal required basename. `minimumSegmentsBeforeRequired`
   counts segments after the exactly matched root and before that sequence;
   `minimumSegmentsAfterRequired` counts segments between the sequence and
   basename, excluding the basename. The normalized feature policy sets both to
   `1`. Portable case/NFC collisions,
   duplicate roots, overlapping roots, zero matches, and multiple matches are
   invalid authority or input. `qualified-leaf-index` is valid only with
   `identity.format: qualified`; `collection` plus `numeric-id-slug` is valid
   only with `identity.format: adr-four-digits`. Every other v1 combination
   admitted by the public schema is allowed.
7. Freeze template transformation and output. A bounded, strict UTF-8 template
   contains exactly one `markdown` fenced skeleton. The skeleton begins with a
   strict YAML placeholder mapping and exactly one leading H1. Foundation
   discards the placeholder frontmatter, replaces the H1 through the selected
   closed heading operator, preserves the remaining Markdown body after line
   ending normalization, and emits canonical frontmatter, LF, and exactly one
   terminal newline. Tags, anchors, aliases, includes, callbacks, and executable
   expressions are forbidden. There is no interpolation language: text that
   resembles an interpolation marker remains literal body text.
8. Freeze canonical metadata order as `id`, `type`, `status`, `owner`,
   `summary`, then present `related`, followed by every `additionalMetadata` key
   in binary order. `related` is the only Foundation-owned set and is unique and
   binary-sorted. Every consumer-owned array preserves caller order and every
   nested map is binary-sorted; Foundation assigns no semantics or priority to
   consumer field names. Additional metadata cannot replace `id`, `type`,
   `status`, `owner`, `summary`, `related`, `title`, `slug`, or `destination`
   and recursively rejects `__proto__`, `prototype`, and `constructor`. It
   remains bounded inert JSON data and the compiled mapping must pass the
   consumer metadata schema. Canonical document JSON additionally rejects
   negative zero and lone UTF-16 surrogate code units in keys or values; schema
   acceptance alone is not authority for these invariants.
9. Domain-separate all document-owned canonical JSON digests with the exact
   wrapper `{domain,payload}` and the domains defined in the protocol contract.
   Intent, owner membership, identity projection, referenced-document, Plan,
   and Receipt digests may not reuse raw undifferentiated JSON hashes. Plan and
   Receipt payloads omit only their own digest fields. Existing authority file,
   output-byte, transaction payload, and envelope digest meanings are retained.
   Digest preimages use that same negative-zero and lone-surrogate rejection.
10. Planning fails closed unless the rebuilt catalog is complete. Identity
    projection is the binary-sorted set of exact `{id,repositoryPath}` entries;
    a partial catalog, duplicate identity, portable path collision, missing
    reference, missing owner, invalid authority, or changed observation cannot
    produce a Plan. A destination that already contains exact planned bytes is
    accepted as the logical self only when its path and document ID exactly
    equal the planned output. That one entry is excluded while reproducing the
    original logical preimage. Every other ID or path collision remains a
    conflict.
11. Compilation requires the destination parent to exist logically and to be a
    real directory before a Plan is emitted. The portable Plan records only the
    repository-relative parent path and the closed logical expectation
    `directory` plus `real-directories`; it does not persist platform inode or
    device identifiers. `expectedParent.path` is exactly the POSIX dirname of
    `destination`; `.` denotes the repository root and is valid only in that
    coordinate. Apply and recovery must recapture the physical parent
    and every ancestor under the shared operation lock immediately before
    publication and fail closed on replacement, redirect, junction, reparse,
    symlink, or unverifiable ancestry.
12. Retain ADR-0022's single operation lock, one physical active transaction
    slot, envelope and recovery-handler boundary, absent-only publication,
    exact-byte classification, cooperative-writer threat model,
    no-delete-after-publication rule, unsupported-filesystem failure, and
    honest Receipt semantics. Unknown, newer, contradictory, or tampered
    evidence is preserved and blocks mutation.
13. Retain the existing contract budgets as normative maxima: repository paths
    are at most 512 UTF-8 bytes with at most 255 bytes per segment; profile,
    metadata schema, and owner catalog authorities are each at most 1 MiB;
    templates are at most 256 KiB; output is at most 1 MiB; a catalog observes
    at most 10,000 documents and 32 MiB total; identity projection has at most
    100,000 entries; owner catalogs have at most 4,096 owners; Intent metadata,
    relation, diagnostic, and other shape limits remain those published in the
    v1 schemas. Character and byte bounds are both enforced where defined.
14. Derive the only owned temporary path through
    `documentTemporaryPath(destination, planDigest)` as the same-parent basename
    `.foundation-document-<64 lowercase Plan-digest hex>.tmp` (89 ASCII bytes).
    Planning fails when that sibling exceeds the 512-byte path or 255-byte
    segment budget; root destinations have no `./` prefix. Its creator handle
    binds `{adapter:"node-filesystem",version:1,dev,ino,birthtimeNs}` using
    canonical unsigned decimal identity strings. Zero is valid wire evidence
    but means physically unverifiable and therefore manual recovery only.
    Non-zero recovery authority requires exact physical identity;
    unsupported or unverifiable identity remains manual-only.
15. Retain v1 non-goals: no identity allocation, directory creation, update or
    deletion, generic Markdown editing, managed index mutation, remote input,
    profile inheritance, consumer code execution, persistent search index,
    portal, organization enforcement, or generic consumer writer.

## Consequences

- One canonical Intent now contains every value that can affect identity,
  destination, or output bytes; compilation no longer depends on an implicit
  CLI-only option.
- Consumers can express heterogeneous qualified identity namespaces through
  bounded data without teaching Foundation their domain terms or supplying
  regular expressions or code.
- The raw donor corpus remains provenance-addressed. Five documents retain exact
  output parity. The feature document is intentionally only semantically
  equivalent because Foundation binary-sorts its nested consumer map as
  `enforcement`, `pattern`, while the donor emitted insertion order `pattern`,
  `enforcement`. The generic Foundation rule takes precedence over byte parity.
- Digests from different semantic domains cannot be substituted even when
  their JSON payloads happen to have the same shape.
- A malformed neighbor makes authoring unavailable until the catalog is fixed.
  Read-only discovery may still report bounded partial results, but mutation
  never treats them as sufficient authority.
- Existing exact output is safely replayable after a lost Receipt, while a
  third-party collision with the same ID or path cannot be hidden as
  idempotency.
- Current v1 profile, Intent, fixture, and known-consumer data must be updated
  atomically. No legacy writer, downgrade path, or v2 alias is added before
  adoption. Exact envelopes produced by the released `0.13.0` and `0.13.1`
  npm build identities are recognized read-only so their evidence is preserved;
  they remain manual-recovery-only and grant no recovery authority.
- Legacy recognition is deliberately evidence-only: it cannot select a handler,
  resume publication, reinterpret corrected v1 data, or authorize mutation.

## Rejected alternatives

- Add `DocumentIntent v2` before any independently deployed v1 consumer exists.
- Use `github-slugger` or host locale rules for filenames.
- Let Foundation guess qualified-ID prefixes or placement from document type.
- Accept arbitrary regular expressions, globs, callbacks, template engines, or
  consumer-provided compilers.
- Sort all consumer arrays as if Foundation owned their semantics.
- Compile from a partial catalog and rely on Apply to discover duplicates.
- Treat matching bytes alone as proof that an existing destination is the
  planned logical self.
- Persist POSIX inode/device identities in a cross-platform Plan.

The complete corrected contract is defined by
[Document authoring protocol](../architecture/document-authoring-protocol.md),
and its security boundary is defined by the
[cooperative writer threat model](../security/document-authoring-threat-model.md).
