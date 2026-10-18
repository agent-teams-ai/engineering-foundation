# Source Dependency Parser Spike

This executable spike compares `oxc-parser` with the exact TypeScript 7.0.2 native
API over one adversarial TypeScript, JavaScript, JSX, TSX, MTS, and CTS corpus.
Both adapters produce the same normalized dependency-reference model before
comparison. Expected truth is asserted independently, so matching parser bugs do
not count as parity.

Run from the repository root:

```text
pnpm parser-spike:check
pnpm spike:source-parser
```

The first command runs deterministic correctness and parity assertions and is
required on Linux and Windows CI. The second also records a local end-to-end
extraction benchmark; timing is evidence only and never a pass/fail threshold.

Both the workspace and spike use TypeScript 7.0.2. The test oracle uses the
`typescript/unstable/sync` native compiler session and its actual AST and binder;
it does not emulate the retired JavaScript Compiler API. Its virtual project has
no libraries or dependency resolution and cannot fall through to disk inputs.
Each observation receives a fresh source identity, preserving real parse work in
the optional benchmark. Snapshots are disposed after inspection and the native
session closes on success or failure. The strict project checks all maintained
spike `.ts` sources before the deterministic corpus runs.

The shared corpus retains all nine parity cases and its separately asserted
source-phase import divergence. The original TypeScript 6 measurements in the
research record remain historical observations; the optional benchmark now
measures the native session, including project update, AST transfer and lexical
lookup. It has no timing threshold.

The spike is evidence, not a production adapter. It performs no repository scan,
does not define the public capability schema, and cannot be imported by the
published foundation package.
