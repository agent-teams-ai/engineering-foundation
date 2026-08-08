# Node TypeScript Library Boundary

Status: Implemented. Consumer qualification is recorded by each consumer.

The closed built-in definitions are:

```text
ScaffoldProfile  foundation.node-typescript-pnpm-esm@1
Recipe           foundation.node-typescript-library-boundary@1
```

The Recipe creates exactly:

```text
<target>/package.json
<target>/tsconfig.json
<target>/src/index.ts
```

The package is private, ESM, composite, declaration-producing, exports compiled
`dist/index.js` and `dist/index.d.ts`, and contains deterministic build,
typecheck, test, clean, check, and prepack commands. The entrypoint is empty so a
consumer must add the accepted first feature in the same reviewed change.

## Consumer ownership

The target catalog owns the target ID, opaque role, path, npm package name, and
owner document ID. The Composition owns admitted roles, authority document roots,
accepted owner statuses, and the `tsconfigBase` path. Foundation resolves the
owner ID from canonical source and supplies only that verified ID to the Recipe.

```yaml
schemaVersion: 2
projectId: example
targetCatalogPath: architecture/package-catalog.yaml
compositions:
  - id: library-boundary
    scaffoldProfile:
      ref:
        id: foundation.node-typescript-pnpm-esm
        contractVersion: 1
      parameters:
        tsconfigBase: tsconfig.json
    recipe:
      ref:
        id: foundation.node-typescript-library-boundary
        contractVersion: 1
    targetRoles: [consumer-owned-role]
    authorityVerifiers:
      - id: foundation.markdown-yaml-owner
        contractVersion: 1
        parameters:
          allowedStatuses: [accepted, active]
          documentRoots: [docs]
    policies: []
```

The Recipe has no parameters or Facets. Unknown or consumer-fixed Recipe
parameters fail closed. The TypeScript base must be outside the target package.

## Exclusions

The Recipe does not create applications, bounded contexts, features, DDD layers,
tests, Nx projects, root workspace references, dependencies, migrations, or
framework configuration. Consumer validators remain responsible for package
topology and for proving the completed package after Apply.

Use `scaffold-plan`, review and save the exact Plan, then use `scaffold-apply`.
Never replace that boundary with an implicit one-shot Plan-and-Apply command.
