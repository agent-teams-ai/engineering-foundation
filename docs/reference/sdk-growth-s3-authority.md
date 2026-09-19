# SDK growth S3 trusted authority integration

Engineering Foundation exposes the opt-in
`@agent-teams/engineering-foundation/sdk-growth-authority` entrypoint for a
trusted host such as ReviewRouter. The entrypoint is an EF port and adapter
boundary. It does not implement ReviewRouter authentication, persistence,
workflow dispatch, status publication, or consumer activation.

The ordinary `foundation:check` route remains unchanged. Its filesystem context
rejects embedded verified claims and cannot produce trusted authority. The S3
entrypoint accepts an executable transport only through trusted host composition;
consumer configuration cannot select a transport or load a plugin.

## Bound execution

The closed `reviewrouter:sdk-growth-authority:1` request binds the provider
repository ID, pull request, head, base, merge base, exact evaluation source,
verifier revision, Foundation archive and installed distribution identities,
extractor, lock and build invocation, policy, command, scope, enrollment,
history, and evidence manifest. EF recomputes the local invocation, policy bytes,
scope, command and report identities. The authority adapter requires exact grant
agreement before it injects trusted context through the existing
`GrowthInputContextPort`.

Candidate decisions remain proposals. Authenticated owner evidence binds the
complete normalized Decision digest. Candidate historical files are parsed by
the existing rejecting boundary, but grant no authority. Trusted release and
history content comes from the host grant and must match the configured package
set and exact archive evidence.

Authority does not change surface semantics. Unsupported or unavailable
coverage remains incomplete, all seven phases retain their frozen order, and a
qualified initial-unreleased record waives only nonexistent published
compatibility obligations. It does not create a v1 baseline or waive
first-surface admission.

## Acyclic custody

Digests follow one direction:

```text
request -> grant -> finalized EF report -> completion -> final receipt
```

Each object has its own domain. The report's existing `receiptDigest` contains
the input grant digest. The final receipt binds the completion and finalized
report; EF never rewrites the report with that later receipt. A promotion plan
binds destination, operation, exact preimage and proposed bytes before its
authorizing completion, so it introduces no digest cycle.

## Promotion

Schema v1 promotion retains its existing path. Schema v2 promotion exists only
on the trusted entrypoint and requires an authenticated qualified check receipt
for the same binding and finalized admitted report. EF then runs the existing
typed and artifact compatibility, SemVer and decision preflight, captures every
write in one promotion plan, obtains a qualified receipt for that exact plan,
rereads invocation identity, and applies the writes with exact preimage checks.
Any mismatched receipt or destination prevents every write. Exact already-applied
outputs remain replayable; changed preimages fail closed.

This integration does not claim external ReviewRouter publication or a positive
activation result. Real activation still requires ReviewRouter-controlled
custody, exact qualified archives, complete supported coverage, current target
verification, and an externally controlled required status producer.
