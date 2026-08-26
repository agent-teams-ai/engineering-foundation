# Agent Architecture Standard product decision brief

Status: Accepted product decisions; D5 is resolved overlay-first by its bounded
spike and independent adversarial review

Date: 2026-08-26

Related documents:

- [Design study](agent-architecture-standard-design.md)
- [Implementation plan](agent-architecture-standard-implementation-plan.md)
- [Accepted incubation ADR](../decisions/0036-incubate-agent-architecture-standard.md)
- [D5 operation spike](agent-architecture-standard-operation-spike.md)

## 1. Purpose

This brief translates implementation-plan checkpoints D0-D11 into product
choices. It separates decisions that create public commitments from decisions
that can be revised after the first working evidence. The product owner accepted
D0-D11 on 2026-08-26. The D5 spike subsequently rejected three independently
claimable public operations for the first slice and selected overlay-first.

Five independent hosted reviewers assessed every question from different
positions: open-source product strategy, standards architecture, security and
release engineering, agent and consumer UX, and pragmatic MVP delivery. Their
votes are advisory. A majority is useful evidence, not decision authority.

Score legend:

- 🎯 confidence that the option is the right choice;
- 🛡️ reliability if the option is implemented correctly;
- 🧠 implementation and operating complexity, where a higher score is harder;
- approximate lines include the directly implied production, tests, fixtures,
  and decision or release changes, not the whole initiative.

## 2. Decision order

| When | Decisions | Why |
| --- | --- | --- |
| Before public identifiers or implementation PRs | D0-D4, D10 | These choices shape package names, dependency direction, wire identities, and the portable security contract |
| Before the first complete vertical slice | D5-D6 | These choices define what users can do and how project rules compose |
| Before public package publication | D9, D11 | These choices define release trust and who may change the standard |
| Before real consumer activation | D7 | Consumer bindings must reflect real repository semantics |
| Before any rule becomes blocking | D8 | Promotion needs measured false-block and escape evidence |

## 3. Decision summary

The table is the accepted decision set. Detailed trade-offs and reviewer votes
follow in Section 4 so future changes retain the original reasoning.

| ID | Preferred direction | Reversibility | Decision deadline |
| --- | --- | --- | --- |
| D0 | Use the full Agent Architecture Standard name publicly; keep protocol as a component, not a second promoted brand yet | Medium before publication, low after ecosystem adoption | Before PR0 public names |
| D1 | Incubate privately in Foundation, but move normative standard and independent conformance authority to a neutral repository before public 0.x | Medium before publication, low afterward | Before public schemas or conformance claims |
| D2 | Use an authority matrix: serialization profile/prose own lexical bytes and canonicalization, schemas own decoded structure, registries own IDs, prose owns semantic algorithms, and vectors are projections; generated TypeScript owns nothing normative | Low after publication | Before schemas or codecs |
| D3 | Exact RFC 8785 over a documented I-JSON subset with domain-separated SHA-256 identities | Very low | Before any persistent digest |
| D4 | Define portable-bounded and hardened snapshot profiles; implement portable first and reserve hard gates for a matching threat profile | Low | Before filesystem adapters |
| D5 | Publish `validate-overlay@1` first; keep classification and relation evaluation internal or experimental until their contracts independently pass the admission gate | Medium in 0.x | Before operation schemas |
| D6 | Standardize only closed effective policy, digest, and provenance in v0.x; keep composition and presets outside the normative runtime | High | Before consumer configuration |
| D7 | Dogfood in Foundation, prove one separate consumer, then add Platform or an external design partner from evidence | High while advisory | Before each consumer PR |
| D8 | Use shadow, advisory, and required as semantic states; model limited rollout as separate scope and implement blocking only after evidence | High per rule | State model before bindings; blocking later |
| D9 | Publish public `-rc.N` artifacts under a non-`latest` tag, collect exact-artifact evidence, then publish a separately qualified numeric 0.x | Medium before first release | Before publication automation |
| D10 | Separate package-dependency and qualification/publication DAGs; conformance stays independent and the cohort manifest closes publication | Low | Before package scaffolding and publisher migration |
| D11 | Establish lightweight explicit governance and separated normative/release authority before public 0.x; defer a formal standards body | Medium | Before the first public cohort |

### Independent reviewer consensus

| ID | Result | Interpretation |
| --- | --- | --- |
| D0 | 5/5 require the full public name; 4/5 defer a separately promoted AAP brand | One searchable product first; protocol remains a technical component |
| D1 | 4/5 want neutral normative authority before public 0.x | Private Foundation incubation is acceptable; public vendor capture is not |
| D2 | 5/5 choose a claim-specific authority matrix | “All artifacts are normative” is insufficient without conflict ownership |
| D3 | 5/5 choose RFC 8785, a strict subset, domain tags, and independent vectors | Identity is effectively irreversible and should use an existing standard |
| D4 | 5/5 require explicitly named security guarantees | Reviewers differ on weaker versus stronger extra profiles, but reject an overclaimed single guarantee |
| D5 | 3/5 initially chose all three operations; the preregistered spike and independent adversarial review selected overlay-first | Measured contract overlap and overlay false-passes outweighed the initial vote |
| D6 | 4/5 standardize only effective policy in v0.x | Normative module composition is the clearest removable overengineering |
| D7 | 5/5 keep architecture semantics consumer-owned; 4/5 reduce the first cohort | Reuse operational safety early, semantic presets only after parity evidence |
| D8 | 3/5 retain four promotion states; 1/5 prefers three states plus scope; 1/5 implements advisory first | The synthesis favors orthogonal scope despite the narrow vote majority |
| D9 | 4/5 favor a public prerelease channel | The owner accepted the majority path: public RC evidence first, numeric 0.x only after separate qualification |
| D10 | 5/5 separate dependency and qualification/publication DAGs | Conformance is a sibling of reference and must remain black-box independent |
| D11 | 5/5 require explicit lightweight authority before public 0.x | No reviewer recommends a formal standards body now |

The strongest robust choices are D2, D3, D6, D10, and the minimum part of D11.
D8 retains evidence-dependent promotion choices. D5 is resolved overlay-first,
and D9 is resolved in favor of the public prerelease channel.

## 4. Product questions and options

### D0. What should the public product be called?

**In plain language:** decide whether the project is a broad standard, only a
request/response protocol, or a uniquely branded product. This name will appear
in packages, schemas, search results, documentation, and community discussion.

**Option A, preferred:** use the full `Agent Architecture Standard` name and
full `agent-architecture-*` public identifiers. Describe the protocol as a
component, but do not promote AAS and AAP as two independent brands yet.

🎯 9/10 🛡️ 9/10 🧠 3/10, approximately 100-800 lines.

- Strength: accurately leaves room for semantics, conformance, profiles, and a
  future protocol without paying for two public brands before interoperability
  exists.
- Risk: the descriptive name is less distinctive, so package, domain, standards
  catalog, and trademark checks still matter.
- Reversibility: moderate before publication and poor after external adoption.

**Option B:** publicly brand both Agent Architecture Standard (AAS) and Agent
Architecture Protocol (AAP) from the first release.

🎯 6/10 🛡️ 7/10 🧠 6/10, approximately 300-1,200 lines.

- Strength: clearly distinguishes the semantic standard from request/response
  contracts.
- Risk: creates two generic marks; AAS already has a strong industrial
  association, while AAP can be confused with MCP, A2A, or ACP.

**Option C:** choose a distinctive new brand and use “agent architecture
standard” only as a description.

🎯 6/10 🛡️ 8/10 🧠 5/10, approximately 250-600 lines plus naming research.

- Strength: stronger searchability and namespace ownership.
- Risk: the brand does not explain the product and delays delivery.

**Accepted decision:** choose A unless collision and trademark research rejects the
full name. AAP can become a public sub-brand when a real cross-product transport
or protocol ecosystem exists. Decide before PR0 creates public identifiers.

### D1. Where should the standard live initially?

**In plain language:** decide whether development begins in the existing
Foundation monorepo or in a new neutral repository. This affects delivery speed,
perceived independence, CI, releases, and later community governance.

**Option A, preferred:** allow private incubation in Foundation, but place the
normative standard and independently owned conformance suite in a neutral
repository before the first public schema namespace or 0.x conformance claim.
The Node reference and Foundation adapter may remain implementation projects.

🎯 8/10 🛡️ 9/10 🧠 7/10, approximately 2,000-5,000 lines.

- Strength: preserves fast incubation while preventing Foundation history,
  access rights, and release credentials from becoming hidden normative power.
- Risk: a neutral repository is cosmetic unless D11 also separates normative
  and implementation authority.
- Reversibility: moderate during private incubation and poor after publication.

**Option B:** publish the first 0.x from the Foundation monorepo with standalone
packages and an objective migration trigger before v1 or a second independent
implementation.

🎯 7/10 🛡️ 7/10 🧠 5/10, approximately 700-2,500 lines.

- Strength: fastest path to a real vertical slice.
- Risk: public schema IDs, contribution history, and conformance marks make a
  later migration much less neutral than it appears.

**Option C:** create a separate repository immediately for standard, reference,
conformance, and all release machinery.

🎯 6/10 🛡️ 8/10 🧠 9/10, approximately 4,000-7,000 lines.

- Strength: maximal physical separation from the beginning.
- Risk: duplicates infrastructure and governance before the product contract is
  proven, while still not creating independent maintainers by itself.

**Accepted decision:** choose A. Decide the incubation location now and the durable
public authority before any public schema or conformance identity is published.

### D2. Which files define the truth of the standard?

**In plain language:** when prose, schemas, generated types, registries, and test
vectors disagree, tools and implementers need one deterministic answer.

**Option A, preferred:** use a typed authority matrix. The serialization profile
and normative prose own lexical byte admissibility and canonicalization. JSON
Schemas own decoded structure, registries own identifiers, and normative prose
owns semantic algorithms that schemas cannot express. Golden vectors are
testable projections and cannot introduce or override a rule. Generate
TypeScript from those artifacts and fail CI on drift or authority conflict.

🎯 10/10 🛡️ 9/10 🧠 6/10, approximately 1,200-2,500 lines.

- Strength: language neutrality without claiming several files are equally
  authoritative for the same fact.
- Risk: ambiguous ownership unless every normative rule maps to one authority
  and conformance evidence.
- Reversibility: low after third-party implementations exist.

**Option B:** define an implementation-neutral IDL as the only source and
generate schemas, registries, bindings, and most documentation.

🎯 7/10 🛡️ 8/10 🧠 8/10, approximately 2,500-5,000 lines.

- Strength: powerful single-source generation.
- Risk: designing a second language and generator before the semantics are
  stable.

**Option C:** make TypeScript types and runtime codecs authoritative and export
schemas from them.

🎯 4/10 🛡️ 6/10 🧠 4/10, approximately 700-1,500 lines.

- Strength: convenient for the first implementation.
- Risk: makes a language-neutral standard depend on Node implementation detail.

**Accepted decision:** choose A and require an executable normative traceability
matrix. An authority conflict blocks release until the owning artifact and every
projection agree. Decide before PR1 schemas and code generation.

### D3. How do independent tools compute the same identity?

**In plain language:** two agents on different languages and operating systems
must produce the same digest for semantically identical policy, snapshots, and
evidence. Otherwise caching, stale-result detection, and receipts are untrusted.

**Option A, preferred:** exact RFC 8785 canonical JSON over a documented I-JSON
subset, SHA-256, explicit domain tags, and independent exact-byte vectors.

🎯 10/10 🛡️ 9/10 🧠 7/10, approximately 1,800-3,500 lines.

- Strength: uses an existing cross-language canonicalization standard and makes
  identity inputs explicit.
- Risk: Unicode, number, path, and self-digest edge cases require hostile
  fixtures and an independent oracle.
- Reversibility: very low because identities persist in evidence.

**Option B:** define a custom deterministic JSON serializer optimized for the
first Node implementation.

🎯 4/10 🛡️ 5/10 🧠 6/10, approximately 1,200-2,500 lines.

- Strength: superficially simpler implementation.
- Risk: hidden cross-language divergence becomes part of the standard.

**Option C:** use deterministic CBOR as the identity encoding while retaining
JSON for user-facing envelopes.

🎯 6/10 🛡️ 9/10 🧠 8/10, approximately 2,500-4,500 lines.

- Strength: strong binary canonicalization model.
- Risk: two encodings complicate debugging and the initial ecosystem.

**Accepted decision:** choose A and treat its vectors as release-blocking. Decide
before any snapshot, policy, request, or receipt digest is implemented.

### D4. What security guarantee must every snapshot provider meet?

**In plain language:** define what repository inspection is allowed to read or
execute. A portable tool must not escape the repository, follow hostile links,
run project code, or silently return incomplete data as a successful snapshot.

**Option A, preferred:** define two named guarantees now. Implement a
portable-bounded profile first with root-relative manifest scope, no symlink
following, bounded capture, no execution or network, explicit coverage, and
honest `unsupported`. Reserve hard enforcement against stronger attacker models
for a later hardened handle-relative or sandboxed profile.

🎯 9/10 🛡️ 9/10 🧠 8/10, approximately 2,500-5,000 lines for the first profile
and 7,000-13,000 additional lines only when the hardened profile is admitted.

- Strength: the first implementation stays portable while the result states the
  exact threat guarantee instead of overclaiming “secure snapshot.”
- Risk: profile negotiation and enforcement eligibility must be explicit; a
  portable advisory result cannot silently satisfy a hardened merge gate.
- Reversibility: low once providers claim conformance.

**Option B:** use one portable profile as both the minimum and hard-gate
guarantee, retaining the plan's same-user and TOCTOU limitations.

🎯 7/10 🛡️ 7/10 🧠 7/10, approximately 3,500-5,000 lines.

- Strength: one simpler provider contract.
- Risk: users may interpret portable no-follow checks as containment from a
  hostile same-user process, especially on Windows reparse points and races.

**Option C:** capture only immutable Git trees and represent every uncommitted
change as a declarative overlay.

🎯 7/10 🛡️ 9/10 🧠 5/10, approximately 2,500-4,000 lines.

- Strength: much cleaner immutable security and identity model.
- Risk: worsens local agent UX and cannot naturally represent every dirty
  worktree or generated artifact.

**Accepted decision:** choose A, implement only the bounded profile in the first
slice, and keep it shadow or advisory until its threat model matches the gate.
Decide before snapshot schemas and the Node discovery adapter.

### D5. What useful work belongs in the first product slice?

**In plain language:** define the smallest release that materially helps an
agent: understand planned files, check intended dependencies, and validate the
exact proposed change without modifying the repository.

**Option A, reviewer-majority priority:** publish all three independent operations,
`classify-subjects@1`, `evaluate-relations@1`, and `validate-overlay@1`, and
expose one composed non-normative agent workflow.

🎯 8/10 🛡️ 9/10 🧠 7/10, approximately 4,000-13,000 lines.

- Strength: provides useful planning and explanation before a patch exists and
  keeps capabilities independently substitutable.
- Risk: commits to three operation contracts before product evidence shows that
  agents need those boundaries.
- Reversibility: medium; operation profiles can evolve in 0.x, but published IDs
  and semantics cannot simply disappear.

**Option B:** publish only `validate-overlay@1` first, with explicit subjects,
relations, effective policy, and coverage. Keep classify and relation evaluation
internal or experimental until the overlay wedge is proven.

🎯 8/10 🛡️ 8/10 🧠 5/10, approximately 1,800-8,000 lines depending on snapshot
and evidence depth.

- Strength: delivers the clearest job-to-be-done, “prove this exact planned
  change before and after integration,” with much less permanent API surface.
- Risk: the workflow may validate caller assumptions instead of helping the
  agent discover architecture before a patch exists.

**Option C:** publish relation evaluation plus overlay validation, leaving
classification entirely consumer-owned.

🎯 7/10 🛡️ 8/10 🧠 5/10, approximately 2,800-5,000 lines.

- Strength: a balanced surface with explicit dependency decisions.
- Risk: consumers may reimplement classification inconsistently.

**Accepted decision:** choose B, overlay-first. The preregistered spike did show
real pre-overlay utility, but independent adversarial review found identity
coupling between classification and evaluation, duplicate repair actions, order-
sensitive prospective identities, and false-pass overlay mutations. Those
failures violate the admission gate for independently claimable operations.
`classify-subjects@1` and `evaluate-relations@1` therefore remain internal or
experimental until a future, separately preregistered proof establishes narrow,
non-overlapping contracts. The spike is evidence, not production code, and the
prototype validator's defects must be fixed in the normative implementation.

### D6. How can projects combine architecture rules without creating a giant preset?

**In plain language:** projects need convenience and flexibility. The system
must combine reusable rule sets predictably, show why a rule applies, and avoid
turning configuration into executable plugins or an unbounded DSL.

**Option A, preferred for v0.x:** standardize one closed immutable effective
policy document per scope, its digest, provenance, and consumer binding.
Foundation may provide non-normative helpers or presets that generate a reviewed
policy diff, but composition is not part of the protocol yet.

🎯 10/10 🛡️ 9/10 🧠 4/10, approximately 400-3,000 lines.

- Strength: providers remain substitutable on the policy they evaluate without
  standardizing a second configuration language before two consumers need it.
- Risk: projects temporarily duplicate policy source or depend on a
  Foundation-specific generator.
- Reversibility: high because a versioned module-composition profile can be
  added later without changing existing effective-policy meaning.

**Option B:** make small immutable vocabulary, evaluator, and policy modules,
presets, overrides, and one provenance compiler normative from v0.x.

🎯 7/10 🛡️ 9/10 🧠 8/10, approximately 3,000-7,000 lines.

- Strength: strong reuse and deterministic explanation from the first release.
- Risk: ordering, conflicts, overrides, and preset upgrades form a hidden DSL
  before shared semantics are proven.

**Option C:** build a universal rule DSL, executable plugin API, and generic
deep-merge configuration now.

🎯 4/10 🛡️ 6/10 🧠 10/10, approximately 8,000-15,000 lines.

- Strength: maximum theoretical expressiveness.
- Risk: creates a programming platform before real rule semantics and security
  boundaries are proven.

**Accepted decision:** choose A. Admit B only after two consumers need to exchange
the same composition semantics, not merely similar rule names. Decide before
binding and effective-policy schemas are implemented.

### D7. Which real projects should prove the design first?

**In plain language:** a standard is not proven by its own tests. We need real,
different repositories to show that the same protocol works without moving
their business architecture into Foundation.

**Option A, preferred:** Foundation dogfoods the public boundary and
Orchestrator provides the first separately owned binding in shadow or advisory
mode. Review the evidence, then add Platform or a structurally different
external design partner. Do not extract a shared preset until two consumers
prove identical semantics and parity fixtures. A shared non-semantic operational
baseline may cover budgets, receipts, security, and inert advisory defaults.

🎯 9/10 🛡️ 9/10 🧠 5/10, approximately 1,500-6,500 lines across the first two
projects.

- Strength: fast real feedback without letting three coordinated adoptions
  block the product wedge.
- Risk: two related internal repositories do not by themselves prove OSS
  interoperability; an external design partner is still needed before broad
  claims.
- Reversibility: high while modes remain shadow or advisory.

**Option B:** activate Foundation, Orchestrator, and Platform as one initial
internal cohort with separate policies.

🎯 7/10 🛡️ 8/10 🧠 7/10, approximately 4,000-9,000 lines.

- Strength: broader internal semantics and operational feedback.
- Risk: coordination cost and Platform readiness delay the first evidence, while
  all three still share organizational assumptions.

**Option C:** start with Foundation plus an external design partner and defer all
other internal consumers.

🎯 7/10 🛡️ 8/10 🧠 7/10, approximately 3,000-6,000 lines.

- Strength: best evidence that the contract is not Foundation-specific.
- Risk: partner recruitment and support can slow early technical iteration.

**Accepted decision:** choose A, approve every binding separately, and require an
external or structurally independent consumer before claiming ecosystem-level
generality. Share operational safety defaults early; share architecture meaning
only after parity evidence. The exact profile can wait until its adoption PR.

### D8. How does an advisory rule become a blocking rule?

**In plain language:** agent guidance can be wrong. The product needs a safe way
to learn from real results before a rule blocks merges, and a narrow rollback if
it starts blocking valid work.

**Option A, preferred:** use semantic states `shadow -> advisory -> required`
with a versioned per-rule promotion record. Model limited rollout separately as
binding scope, cohort, percentage, path, or rule selection. Define the record
now, but do not implement or activate blocking until measured evidence exists.

🎯 9/10 🛡️ 9/10 🧠 5/10, approximately 1,000-3,000 lines initially and a
further 800-1,500 lines when trusted blocking execution is admitted.

- Strength: keeps “what the rule means” separate from “where rollout applies,”
  while retaining evidence, ownership, and per-rule rollback.
- Risk: scope must be immutable and receipt-bound or limited rollout becomes a
  hidden fourth state anyway.
- Reversibility: high because each rule and cohort can fall back independently.

**Option B:** use the plan's four states,
`shadow -> advisory -> limited-required -> required`, in one promotion record.

🎯 8/10 🛡️ 9/10 🧠 7/10, approximately 2,000-4,000 lines.

- Strength: rollout intent is visible in one state machine.
- Risk: `limited-required` conflates enforcement semantics with scope and makes
  historical compatibility harder.

**Option C:** let the system promote rules automatically when observed metrics
cross configured thresholds.

🎯 4/10 🛡️ 5/10 🧠 9/10, approximately 4,000-8,000 lines.

- Strength: low-touch scaling in theory.
- Risk: measurements, repository changes, or biased samples silently change
  merge policy without owner review.

**Accepted decision:** choose A unless implementation proves that scope cannot be
represented independently. Threshold values and required-mode code remain open
until preregistered adoption evidence exists; the record schema and rollback
contract come first.

### D9. How should experimental releases be published?

**In plain language:** consumers need exact installable artifacts and upgrade or
downgrade proof. A public candidate channel makes that evidence realistic
without prematurely moving the stable `latest` tag.

**Option A, rejected no-RC path:** qualify exact packed tarballs and their
consumer canaries before publishing a numeric 0.x cohort. Keep candidates
unpublished or private; call the result a “qualified experimental 0.x,” not a
stable product guarantee. Publish once and fix forward with a new version.

🎯 9/10 🛡️ 9/10 🧠 7/10, approximately 2,500-5,000 lines.

- Strength: clear public versions with artifact-bound evidence and no mutable
  “same version” repair.
- Risk: requires disciplined prepublication qualification and an explicit ADR
  replacing the current RC-wave process.
- Reversibility: medium before the first public cohort and low afterward.

**Option B, accepted:** publish `-rc.N` or beta artifacts on
a non-`latest` prerelease tag, gather external installation evidence, then
publish a separately qualified numeric 0.x.

🎯 9/10 🛡️ 9/10 🧠 6/10, approximately 1,500-3,500 lines.

- Strength: conventional public prerelease feedback.
- Risk: increases visible version churn; mitigate it with one immutable
  candidate per evidence cohort and fix-forward publication only.

**Option C:** let consumers use commit SHAs or private registry snapshots until
v1, then publish a stable package.

🎯 4/10 🛡️ 6/10 🧠 5/10, approximately 1,500-3,000 lines.

- Strength: delays public release machinery.
- Risk: prevents realistic public packaging, provenance, upgrade, downgrade,
  and ecosystem adoption evidence.

**Accepted decision:** choose B. Publish immutable `-rc.N` artifacts only under
a non-`latest` tag, bind external installation and upgrade/downgrade evidence to
their exact bytes, and publish a separately qualified numeric 0.x afterward.
Never promote an unqualified RC to `latest`, rewrite it, or repair it through a
mutable tag; failures are fixed forward with a new RC.

### D10. How does Foundation use the standard without circular self-dependency?

**In plain language:** Foundation should dogfood its tooling, but the standard
must remain independently implementable and conformance must not pass merely
because it reuses the same production code.

**Option A, preferred:** define two related DAGs. Package dependencies are
`standard -> {reference, conformance}` and `reference -> Foundation -> Docs
Protocol`, while conformance has no reference production import. Qualification
runs candidate providers out of process; publication becomes consumer-eligible
only when an immutable cohort manifest closes the evidence set.

🎯 10/10 🛡️ 10/10 🧠 8/10, approximately 2,000-5,000 lines.

- Strength: distinguishes code dependencies from release evidence, enables real
  dogfood, and prevents a partial registry state from looking qualified.
- Risk: publication choreography and bootstrap evidence are more complex than a
  monolithic build; Docs coupling must not delay the core standard cohort.
- Reversibility: low after packages and release automation depend on the DAG.

**Option B:** let Foundation import internal reference source directly and let
conformance reuse the reference canonicalizer.

🎯 3/10 🛡️ 4/10 🧠 4/10, approximately 1,500-3,000 lines.

- Strength: faster local implementation.
- Risk: cyclic ownership and shared bugs create false conformance agreement.

**Option C:** split every package into a separate repository immediately to make
cycles organizationally impossible.

🎯 6/10 🛡️ 9/10 🧠 9/10, approximately 5,000-10,000 lines.

- Strength: maximal physical separation.
- Risk: high release and contribution overhead before the package boundaries
  are proven.

**Accepted decision:** choose A. Decide package direction with D1 before manifests;
the exact Foundation and Docs publication cohort can wait until publisher
migration.

### D11. Who can change and release an open standard?

**In plain language:** public users need to know the license, security channel,
maintainers, compatibility promise, release authority, and how normative changes
are accepted. Without this, “open standard” is only a public code repository.

**Option A, preferred:** establish lightweight explicit governance before the
first public 0.x: SPDX license, contribution policy, code of conduct, security
policy, named maintainers, public normative-change process, namespace and
support policy, and separated normative approval, conformance, and release
authority. Defer a legal standards body until independent contributors exist.

🎯 9/10 🛡️ 9/10 🧠 6/10, approximately 800-3,000 lines.

- Strength: enough trust and decision clarity for early external adoption
  without pretending a mature standards consortium already exists.
- Risk: “neutral” repository language is cosmetic if one implementation owner
  still controls every credential and conformance mark.
- Reversibility: medium; legal and published compatibility commitments are
  harder to change than maintainer workflow.

**Option B:** keep maintainer-owned governance informal until v1.

🎯 5/10 🛡️ 6/10 🧠 3/10, approximately 500-1,000 lines.

- Strength: fastest delivery.
- Risk: weak community trust, ambiguous normative changes, and fragile release
  continuity.

**Option C:** form a neutral multi-vendor standards body before the first 0.x.

🎯 4/10 🛡️ 9/10 🧠 10/10, approximately 3,000-7,000 lines plus substantial
non-code coordination.

- Strength: strongest institutional neutrality.
- Risk: governance precedes users and can freeze the product before evidence
  exists.

**Accepted decision:** choose A, name real people and credentials behind each role,
and define triggers for broader maintainership or neutral stewardship. Decide
the minimum before public 0.x; formal organization and certification can wait.

## 5. Product assessment

The first score is the five-reviewer mean for the implementation plan as
written. The second is the synthesis target after the recommended reductions;
it is a forecast, not evidence from an implementation.

| Dimension | Plan as written | Revised direction | Main reason |
| --- | ---: | ---: | --- |
| Architecture | 8.5/10 | 9.1/10 | Normative standard, replaceable reference, independent conformance, and consumer ownership are strong; removing normative composition sharpens the boundary |
| Underlying idea and product potential | 7.4/10 | 9.2/10 | The problem is real, but the current plan delays proof behind too much platform surface |
| OSS adoption potential | 5.7/10 | 8.3/10 | Neutral normative authority, one brand, a smaller first cohort, and simpler config materially lower the adoption barrier |
| Demonstrated agent effectiveness | 6.6/10 | 9.0/10 potential | Exact snapshots, explanations, and overlays are promising; controlled evals still have to prove fewer escapes and rework |
| Technical defensibility | 8.5/10 | 9.0/10 | Identity-bound evidence, hostile vectors, independent conformance, and integrated validation are a meaningful moat |
| Security and reliability | 8.0/10 | 9.0/10 | Named assurance profiles prevent portable checks from overclaiming hard containment |
| Developer and agent UX | 5.8/10 | 8.4/10 | One brand, one composed workflow, closed effective policy, and generated upgrade diffs reduce cognitive load |
| Extensibility | 8.8/10 | 9.0/10 | Profiles remain additive without forcing plugins, a rule DSL, or normative module composition |
| Delivery feasibility | 4.7/10 | 7.8/10 | Overlay-first evidence and deferring composition/extra consumers can cut the first proof from roughly 22-33 KLOC toward 8-15 KLOC |
| Overengineering risk, higher is worse | 8.4/10 | 4.5/10 | The main excess is known and removable: module compiler, premature operations if the spike rejects them, full promotion runtime, and heavy release coupling |
| Governance readiness | 4.6/10 | 8.0/10 | The required roles and policies are clear, but they must still be assigned and accepted |

The idea itself is stronger than the plan's current product score. The low
scores come mostly from time-to-evidence and adoption friction, not from the core
architecture. The decisive product test is whether agents using the first slice
produce fewer architecture escapes and less rework than agents using the current
Foundation checker and repository documentation.

## 6. Accepted owner decision packet

The owner accepted the following three packets on 2026-08-26:

1. **Public contract packet:** D0-D4 and D10. These choices are expensive to
   reverse and unblock the specification and package boundaries.
2. **First-product packet:** D5 and D6. D5 is settled overlay-first by the
   bounded prototype and independent review; D6 keeps the simpler effective-
   policy boundary before building config.
3. **Publication and adoption packet:** D7-D9 and D11. Consumer ownership and
   promotion structure are accepted. Exact bindings and thresholds remain
   evidence-owned; D9 selects a public non-`latest` RC channel.

Implementation may treat this brief as the owner decision record for sequencing.
Irreversible wire, security, authority, and publication contracts still require
the focused ADRs named by the implementation plan before their code merges.

## 7. Independent review record

All reviewers used `gpt-5.6-sol`, `xhigh` reasoning, and the fast service tier on
hosted subscription runtime. They read the same immutable plan and study at
commit `011fdb88f9009dfa96b4f0eca64b96c9ac763ead` and had no write access.

- `aas-decisions-product-strategy-20260826-r1`
- `aas-decisions-standard-architecture-20260826-r1`
- `aas-decisions-security-release-20260826-r1`
- `aas-decisions-agent-ux-consumers-20260826-r1`
- `aas-decisions-pragmatic-critic-20260826-r1`

The synthesis preserves minority objections where they materially affect public
surface, enforcement, or release policy. Reviewer completion does not accept an
owner decision.
