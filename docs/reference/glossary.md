# Foundation Glossary

Status: Active terminology contract.

This glossary defines the overloaded terms used across Engineering Foundation,
Docs Protocol, and their consumers. The definitions are claim-specific: a word
never grants broader ownership, support, or compatibility than the document says.

Use the linked term on first use in architecture, development, security, and
reference documents. After that, use the short form only while the subject and
scope remain unambiguous. Historical ADRs and changelogs keep their original
wording; this glossary controls current documentation.

## Agent writing rules

When an agent writes or reviews Foundation documentation:

1. Name the subject before `authority`, `evidence`, `journal`, `envelope`, or
   `qualification` when more than one subject is in scope.
2. State the owner and bounded claim for an authority. Do not call an entire
   repository or service "the authority" without saying what it decides.
3. Bind evidence to the exact source revision, artifact digest, environment, and
   result needed by the claim. Evidence is not authority by itself.
4. Name the journal or envelope kind and schema version when persisted or
   machine-readable compatibility matters.
5. Never use bare `qualification` to mean release readiness, capability support,
   consumer adoption, and cohort readiness at the same time. Use one of the
   qualified terms below.
6. Do not replace `admission`, `publication`, `support`, `compatibility`, or
   `approval` with `qualification`; they are different decisions.

## Authority

**Authority** is the source permitted to decide one named claim within a defined
scope. Authority is always claim-specific, owned, and versioned or revision-bound
when another system consumes it.

Examples:

- a consumer package catalog is the authority for that consumer's package IDs;
- an accepted ADR is the authority for the decision it records;
- a Foundation schema is the authority for the shape of its versioned contract;
- a recovery handler has mutation authority only for the journal versions and
  operations it explicitly supports.

Authority does not mean "most trusted file" or "all decisions in this area". A
generated projection can reproduce authoritative bytes without becoming the
authority. CI output can prove that an authority was checked without gaining the
right to redefine it.

Prefer a specific form such as **schema authority**, **policy authority**,
**mutation authority**, **recovery authority**, or **merge authority**.

## Evidence

**Evidence** is an immutable or reproducible observation used to evaluate a
bounded claim. Useful evidence identifies what ran, against which exact source or
artifact, in which relevant environment, and with which outcome.

Examples include a test report bound to a commit SHA, a package integrity digest,
a signed provenance statement, and a deterministic receipt produced after a
mutation. A mutable status page, an unbound log excerpt, or a successful run on a
different revision is not evidence for the current claim.

Evidence does not decide policy and does not broaden its own scope. A Linux test
is not Windows evidence. A packed-artifact check is not proof that a consumer
adopted the artifact. A digest proves identity only when the expected identity and
the hashing boundary are already defined.

Prefer a specific form such as **conformance evidence**, **release evidence**,
**consumer evidence**, **recovery evidence**, or **operational evidence**.

## Cohort

A **Cohort** is an immutable, centrally indexed adoption coordinate for one exact
compatible set of package versions, managed assets, workflow revisions, and
their digests. A Cohort lets multiple consumers select the same tested set without
using floating tags or independently guessing compatible versions.

A Cohort record is an index, not proof by itself. Its lifecycle and linked
evidence determine whether it is eligible for a transition. A **Qualified
Cohort** has passed the centrally declared cohort qualification for its exact
record. It does not prove that every consumer has installed, admitted, or
successfully used the Cohort.

Use **cohort enrollment** for the set of consumers governed by a Cohort and
**cohort admission** for the decision that a particular consumer revision may
enter the governed state.

## Journal

A **journal** is a durable, versioned transaction record written before or during
a repository mutation so an exact compatible implementation can classify,
continue, recover, or safely refuse the interrupted operation.

A journal is not a diagnostic log or general event history. Its schema is closed,
its ownership is explicit, and its fields are part of the recovery contract.
Unknown, contradictory, stale, or unsupported journal state is preserved and
fails closed rather than being guessed or deleted.

Name the journal kind when the context contains more than one transaction family,
for example **scaffolding journal**, **document journal**, or **repository-mutation
journal**. Include the schema version when discussing compatibility or recovery.

## Envelope

An **envelope** is a versioned machine-readable wrapper that identifies the kind
and schema of a payload and carries the bounded metadata required to interpret it.
The wrapped payload retains its own semantics.

Foundation uses different envelope families for command results, errors,
qualification evidence, and persisted transaction state. They are not mutually
substitutable. Name the family and version when exact shape matters, for example
**command error envelope v1**, **Buf qualification envelope v2**, or **transaction
envelope v4**.

An envelope is not automatically evidence. It becomes evidence only when its
producer, identity binding, integrity, and observation scope satisfy the relevant
claim.

## Qualification

**Qualification** is the evaluation of one explicitly named subject against a
declared set of criteria, producing bounded evidence and a pass/fail result. The
subject, environment, criteria, evidence, and decision owner must be clear.

`Qualified` never means universally correct, supported, compatible, released, or
adopted. It means only that the named subject passed the named qualification.
Current documents must use one of these forms or another equally explicit subject.

### Artifact qualification

**Artifact qualification** proves properties of exact built or published bytes.
Package qualification, registry qualification, packed-artifact qualification,
and release qualification are artifact-qualification scopes. Typical evidence
includes package contents, exports, integrity, provenance, install behavior,
reproducibility, and upgrade/downgrade compatibility.

Passing artifact qualification does not publish the artifact and does not prove a
consumer adopted it.

### Capability qualification

**Capability qualification** proves that one capability implementation, adapter,
toolchain, or platform satisfies its declared contract. Buf qualification,
scaffolding recipe qualification, QGR lifecycle qualification, and a Windows
adapter qualification are capability-qualification scopes.

Passing capability qualification does not activate the capability in consumers.
The claim applies only to the tested capability, adapter, platform, and contract
version.

### Consumer qualification

**Consumer qualification** proves that one exact consumer revision correctly
declares, installs, configures, and checks an artifact or capability under the
consumer's own policy and CI. It is owned by the consumer and must name the exact
consumer revision and package coordinate.

Passing consumer qualification does not qualify other consumers and does not
change central cohort lifecycle state.

### Cohort qualification

**Cohort qualification** proves that one exact Cohort record and its referenced
artifacts, managed assets, workflow revisions, and transition rules satisfy the
central lifecycle criteria. It produces a Qualified Cohort.

Passing cohort qualification does not admit a consumer revision. Enrollment,
consumer qualification, protected CI, and admission remain separate decisions.

### Qualified identity is not qualification

The document-authoring schema token `identity.format: qualified` names a
hierarchical identifier grammar with declared prefix and separator rules. It does
not mean that an identity passed qualification. Use **qualified identity** only
for that literal schema concept and name its format when readers could confuse it
with a pass/fail state. The token is retained for contract compatibility.

## Enforcement

`pnpm docs:terminology:check` is part of both `check:fast` and `check`. It fails
if this glossary loses a required definition, if a qualification scope
disappears, or if the main documentation entry points stop linking here. The
repository documentation capability separately validates Markdown links and
anchors.

The gate intentionally does not guess natural-language meaning. Reviewers and
agents still apply the writing rules above when a term's subject or claim is
ambiguous.

## Relationship map

| Concept | Decides or records | Must not be confused with |
| --- | --- | --- |
| Authority | Who may decide one bounded claim | Evidence that the claim was checked |
| Evidence | What was observed for one bounded claim | Policy, ownership, or universal proof |
| Cohort | Which exact compatible adoption set is indexed | A consumer deployment or floating release channel |
| Journal | How an interrupted mutation is durably classified | A general log or mutable cache |
| Envelope | How one machine payload family is identified and decoded | The payload's semantics or trust by itself |
| Qualification | Whether one named subject passed declared criteria | Publication, admission, support, compatibility, or approval |

The normal relationship is:

```text
authority defines claim and criteria
  -> implementation performs bounded work
  -> evidence records the exact observation
  -> qualification evaluates one named subject
  -> a separate publication or admission decision may consume that result
```
