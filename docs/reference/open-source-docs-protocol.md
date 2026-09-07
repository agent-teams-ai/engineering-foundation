# Open-Source Docs Protocol

Status: Community workflow accepted by ADR-0039 and implemented for the
artifact-qualified coordinates `@agent-teams/docs-protocol@0.4.0` and optional
`@agent-teams/docs-protocol-mcp@0.1.0`. Source or release-branch state never
proves availability: proceed only when the exact registry checks below resolve
both requested versions from public npm.

This workflow keeps documentation as ordinary repository-owned Markdown and
YAML. Generated search and context output is disposable and non-authoritative.
It does not require the Agent Teams managed preset, a site, or a portal.

## Requirements

- Node `>=24.18.0 <25` until a later compatibility decision qualifies more
  runtimes;
- a clean reviewable repository state before bootstrap apply;
- one exact package version, committed in the consumer manifest and lockfile;
- no `latest`, ranges, floating `npx`, or floating `dlx` invocation.

Bootstrap apply and transaction recovery are initially capability-qualified on POSIX
systems only. On Windows, use a repository whose portable authority was
initialized on a supported POSIX host, reviewed, committed, and then cloned;
the read-only `info`, `find`, `context`, `check`, and MCP flows are capability-qualified
there. Do not run or automate local Windows `init --apply` or recovery until a
release explicitly adds durable Windows transaction evidence.

## Install one exact version

The initial portable release qualifies npm and pnpm. First prove that the exact
CLI coordinate exists. Override both the default and scoped registry so user or
repository configuration cannot silently redirect one request:

```bash
npm view @agent-teams/docs-protocol@0.4.0 version --json \
  --registry=https://registry.npmjs.org/ \
  --@agent-teams:registry=https://registry.npmjs.org/
```

```bash
pnpm view @agent-teams/docs-protocol@0.4.0 version --json \
  --config.registry=https://registry.npmjs.org/ \
  --config.@agent-teams:registry=https://registry.npmjs.org/
```

The command must return exactly `0.4.0`. Then use the package manager already
authoritative for the repository:

```bash
npm install --save-dev --save-exact \
  --registry=https://registry.npmjs.org/ \
  --@agent-teams:registry=https://registry.npmjs.org/ \
  @agent-teams/docs-protocol@0.4.0
```

```bash
pnpm add --save-dev --save-exact \
  --config.registry=https://registry.npmjs.org/ \
  --config.@agent-teams:registry=https://registry.npmjs.org/ \
  @agent-teams/docs-protocol@0.4.0
```

Commit the resulting manifest and native lockfile. Do not create a second
lockfile. Package-manager installation support does not make Bun or another
engine a capability-qualified runtime; run the CLI on the capability-qualified Node version. Yarn and
Bun installation are not yet support claims: each needs its own packed-registry,
installed-binary, recovery, and cross-platform capability qualification before its command
is documented here.

Add stable repository scripts so contributors invoke the installed binary:

```json
{
  "scripts": {
    "docs:init": "agent-teams-docs init",
    "docs:find": "agent-teams-docs find",
    "docs:context": "agent-teams-docs context",
    "docs:new": "agent-teams-docs new",
    "docs:check": "agent-teams-docs check"
  }
}
```

The examples below use the binary name for package-manager-neutral clarity.
Calling the equivalent committed script is preferred in repository automation.

## Preview and apply bootstrap

Run this section on a capability-qualified POSIX system. Windows consumers start from the
committed preinitialized authority described in Requirements and continue with
the read-only daily workflow.

Start with a non-mutating preview:

```bash
docs-protocol init --project-id example/widgets \
  --owner documentation/team --dry-run
```

Review the complete file set, every exact-preimage replacement, every
create-absent path, the selected portable profile, diagnostics, and Plan digest.
Then apply the same inputs explicitly:

```bash
docs-protocol init --project-id example/widgets \
  --owner documentation/team --apply \
  --expect sha256:PLAN_DIGEST_FROM_DRY_RUN
```

Dry-run does not reserve paths or mutate the repository. Apply recompiles under
the Foundation operation barrier. If a reviewed preimage changed, a path now
exists, or authority drifted, it fails closed and requires a new dry-run. It
does not force, delete, rename, execute package-manager lifecycle hooks, or
best-effort merge unrelated text.

Bootstrap creates the inert Markdown/YAML authority, templates, local authoring
Skill, documentation category indexes, and one marker-bounded `AGENTS.md`
instruction. It does not edit the package manifest or lockfile. Inspect an
interrupted transaction with the exact installed build before changing package
versions; do not hand-edit transaction evidence.

## Daily workflow

Search before creating a competing source:

```bash
docs-protocol find "tenant isolation" --fuzzy
```

MiniSearch ranking, when enabled, is advisory. Identity checks and authoring
decisions always use a fresh canonical catalog. Zero matches are successful and
do not prove that a concept is absent under another term.

Build bounded context for an agent or review:

```bash
docs-protocol context "tenant isolation" --fuzzy --max-documents 12
```

The output records selection and truncation diagnostics. It is a rebuildable
projection, not a source document or acceptance decision. Do not edit generated
context or `llms.txt`-style output as authority; edit Markdown/YAML and rebuild.

Preview a new document, keeping all caller inputs explicit:

```bash
docs-protocol new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner documentation/team \
  --summary "Defines the tenant-isolation boundary." --dry-run
```

After reviewing destination, metadata, relations, diagnostics, and any manual
reachability instruction, repeat identical authoring inputs with `--apply` and
`--expect`. Use the **new-document preview's Plan digest**, printed as `Plan:`;
this is not the earlier init digest:

```bash
docs-protocol new --type adr --id ADR-0083 \
  --title "Tenant isolation" --owner documentation/team \
  --summary "Defines the tenant-isolation boundary." --apply \
  --expect sha256:PLAN_DIGEST_FROM_DRY_RUN
```

Complete the returned manual reachability instruction by adding its exact
Markdown link to its named index, then finish with the repository check:

```bash
docs-protocol check
```

`check` validates package-owned deterministic rules. A profile never launches
Vale, Lychee, shell commands, package managers, or consumer plugins. If the
repository chooses those tools, pin and run them as explicit independent CI or
operator steps.

## Optional MCP transport

MCP is not required for CLI use. First complete the exact Docs Protocol registry
proof above, then prove the compatible MCP coordinate with the same authoritative
package manager:

```bash
npm view @agent-teams/docs-protocol-mcp@0.1.0 version --json \
  --registry=https://registry.npmjs.org/ \
  --@agent-teams:registry=https://registry.npmjs.org/
```

```bash
pnpm view @agent-teams/docs-protocol-mcp@0.1.0 version --json \
  --config.registry=https://registry.npmjs.org/ \
  --config.@agent-teams:registry=https://registry.npmjs.org/
```

The two registry proofs must return their requested literal versions. Install the pair in
one package-manager transaction so the manifest and native lockfile cannot
record a half-configured transport:

```bash
npm install --save-dev --save-exact \
  --registry=https://registry.npmjs.org/ \
  --@agent-teams:registry=https://registry.npmjs.org/ \
  @agent-teams/docs-protocol@0.4.0 \
  @agent-teams/docs-protocol-mcp@0.1.0
```

```bash
pnpm add --save-dev --save-exact \
  --config.registry=https://registry.npmjs.org/ \
  --config.@agent-teams:registry=https://registry.npmjs.org/ \
  @agent-teams/docs-protocol@0.4.0 \
  @agent-teams/docs-protocol-mcp@0.1.0
```

Configure the installed MCP binary directly in the client; do not invoke it
through `npx`, `pnpm dlx`, another package manager's floating execute mode, or a
`latest` tag.

Start the installed stdio adapter with one fixed repository binding:

```bash
docs-protocol-mcp --consumer-root /absolute/path/to/repository
```

It exposes only `docs_info`, `docs_find`, and `docs_context`. Tool calls cannot
override the startup root or profile, and there are no write, recovery, shell,
network, upgrade, or arbitrary process tools.

The MCP package is only a transport over the same application contracts. It
does not own a second catalog or index, and it does not make generated context
authoritative. Network exposure, remote mutation, authentication, and hosted
multi-tenant operation are not part of the portable profile.

## Authority and safety summary

- Markdown/YAML sources and the portable profile are authority.
- Search indexes, ranked results, context bundles, and `llms.txt` projections
  are rebuildable advice.
- Profiles are inert data: no commands, package/module references, callbacks,
  hooks, environment interpolation, or remote schemas.
- Bootstrap uses only reviewed create-absent and exact-preimage operations.
- The Agent Teams managed preset and Cohort workflow remain separate and
  unchanged.
- A wider Node range or alternative runtime is unsupported until it passes
  separate capability qualification.
