# CI Input Proof

Development/CI-only pure inventory comparison. Do not import this package from
product runtime code. There are no runtime dependencies, I/O, hashing, cache,
Get Modular dependency, execution receipts or merge authority.

```ts
import { compareLeafInventories } from '@agent-teams/ci-input-proof';

const relation = compareLeafInventories(before, after, permittedContentChanges);
```

The Host independently constructs complete inventories and classifies leaves.
Each inventory has exactly `version: 1`, `digestScheme`, and `inputs`. Each leaf
has exactly `path`, `type`, `mode`, `membership`, and `content`. Modes are
file `100644`/`100755`, symlink `120000`, gitlink `160000`; membership is
`closed` or `structural`. Schemes are `git-object-sha1` (nonzero lowercase
40-hex OID) and `sha256` (nonzero lowercase 64-hex digest), without conversion.

Inputs are plain or null-prototype own-data records and stock dense arrays.
Accessors, custom iterators, symbols, extra fields and holes reject without
calling a getter or iterator. Executable Proxies and modified intrinsics are
outside the contract. Inventories have 1–65,536 leaves and at least one closed
leaf. Literal relative paths have at most 4096 code units, no empty/dot/dot-dot
segments, backslashes, absolute drive prefixes or ASCII controls/DEL. Case and
Unicode spelling retain their identity; no filesystem canonicalization occurs.

Both inventories must have the same path set, type, mode and membership.
Closed content cannot change. Structural content may change only for an exact
permitted existing structural path. Permissions are a dense unique path list,
bounded by the leaf count; extra permissions for closed/missing leaves reject.

`compatible-inputs` returns frozen ordinal `changedContentPaths` for actually
changed permitted leaves, including an empty array for equal inventories.
`rejected` returns a frozen stable reason. Validation order is before inventory,
after inventory, scheme equality, permissions, structure, then content. Results
retain no caller references. A compatible relation proves neither semantic
completeness, authentication, successful tests, eligibility nor permission to
omit a check. Runtime-specific narrower eligibility remains consumer-owned.

This initial source checkpoint is not a published or activated consumer release.
Consumer parity, package qualification, current-head CI, independent review and
separately authorized registry publication remain required before adoption.
