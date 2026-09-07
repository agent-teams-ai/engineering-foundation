# `@agent-teams/docs-protocol-agent-teams`

Agent Teams managed integration for the portable
`@agent-teams/docs-protocol` package.

This package exclusively owns Cohort authority, managed consumer state,
transition projectors, managed workflows, managed qualification, and historical
managed assets. It depends on the portable package through that package's public
Node contracts; the portable package never discovers or imports this adapter.

The current managed contract uses Qualified Cohort v2, integration profile v3,
managed state v2, and qualification receipt v3. A Cohort binds exactly five npm
coordinates and their exact versions and SHA-512 integrities:

- `@agent-teams/repository-mutation`;
- `@agent-teams/document-authoring`;
- `@agent-teams/docs-protocol`;
- `@agent-teams/docs-protocol-agent-teams`; and
- `@agent-teams/engineering-foundation`.

A consumer declares only Docs Protocol, Docs Protocol Agent Teams, and
Engineering Foundation as root development dependencies. Repository Mutation
and Document Authoring remain exact transitive coordinates verified against the
lockfile. Independent floating package updates are not Cohort authority.

Managed operations use the distinct executable:

```text
agent-teams-docs-managed check --consumer .
agent-teams-docs-managed plan --consumer . --to COHORT
agent-teams-docs-managed apply --consumer . --expect sha256:DIGEST
agent-teams-docs-managed upgrade --consumer . --to COHORT --target-generation 2
agent-teams-docs-managed recover --consumer .
agent-teams-docs-managed qualify --consumer .
```

The portable `agent-teams-docs` and `docs-protocol` executables contain only
generic documentation commands. There is no legacy `agent-teams-docs consumer`
route, runtime compatibility bridge, optional adapter lookup, or dynamic
version detection. V1 records are immutable historical migration and rollback
evidence. Existing V1 consumers retain exact check, recovery, and same-generation
upgrade commands, but those commands never infer or synthesize V2 and are not a
cross-generation compatibility mode.

The explicit `--target-generation 2` route performs the bounded, reversible,
one-time Profile v1/Cohort v1 to Profile v3/Cohort v2 migration. It stages and
proves the successor in a disposable copy, publishes once, and restores exact
source evidence if activation fails. It is not a bridge, alias, dual writer, or
permission to emit new v1 records.

Portable profile v4 is a separate, optional consumer change. The managed owner
exports `projectManagedPortableProfileV4(v3Bytes)` to produce reviewable UTF-8
JSON (also valid YAML) from one strict portable profile v3. It preserves the
consumer's authoring path, Skill route and semantic validator IDs, and explicitly
sets blocker type `open-decision`, target statuses `deferred` / `open`, and
incompatible subject statuses `accepted` / `active`. Unknown keys, duplicates,
aliases, tags, mixed generations and paths incompatible with v4 are rejected.
The projection only returns bytes; it does not read or write consumer files.

Qualify the successor Docs Protocol reader before selecting v4: v3-only readers
reject it. Review the returned bytes and use the existing known-file transaction
Plan/Apply workflow with the exact saved v3 preimage. Finish or preserve any
pending transaction through its exact recorded recovery artifact first. Cohort
upgrade commands do not automatically invoke this migration. Managed integration
profile v3, Cohort v2, managed state v2 and qualification receipt v3 retain their
identities; historical state, asset catalogs and recovery evidence are not
rewritten or reinterpreted. A portable profile is not an additional managed-state
asset or a new qualification-receipt generation.

The qualification fixture selects portable v4 explicitly and is tested against
the reviewed portable producer candidate. Existing canonical asset generation
and Cohort qualification mechanisms still compute their own digests. Restoring
the saved v3 profile is an explicit rollback only while its paths and document
vocabulary satisfy v3 and no incompatible transaction is pending; downgrading a
package alone is not recovery. Published versions remain immutable.
