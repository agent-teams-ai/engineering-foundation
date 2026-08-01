# Source Dependency Parser Spike

This executable spike compares `oxc-parser` with the stable TypeScript 6 Compiler
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

The TypeScript package in this workspace remains version 7. The spike package is
an isolated compatibility lane pinned to TypeScript 6.0.3 because TypeScript 7.0.2
does not expose the established JavaScript Compiler API; its new AST API remains
under `typescript/unstable/*` exports.

The spike is evidence, not a production adapter. It performs no repository scan,
does not define the public capability schema, and cannot be imported by the
published foundation package.
