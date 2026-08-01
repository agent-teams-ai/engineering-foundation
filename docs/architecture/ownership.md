# Ownership Boundary

The foundation owns reusable engineering mechanisms:

- configuration contracts and generic validators;
- tool presets and capability runners;
- local versus registry lifecycle tooling;
- generic scaffolding primitives and conformance fixtures;
- publishable package and release mechanics.

A consumer owns business and repository facts:

- bounded contexts and feature topology;
- package identities and allowed dependency relationships;
- data classifications and threat scenarios;
- domain terminology, ADRs, and open decisions;
- project-specific capability configuration and fixtures.

The consumer supplies those facts through a narrow configuration adapter. The
foundation validates and executes them but cannot invent or override them.

Capabilities are feature-owned policy surfaces with granular identifiers. Broad
menu categories such as `architecture` or `documentation` are not capability
boundaries. The built-in registry is static and private; consumers provide data,
not executable plugins or rule functions.

Package-manager files, source parsers, and other external formats are outbound
adapter concerns. Their objects do not become capability policy models. The
first accepted split is:

- `workspace.dependency-declarations` for declared workspace dependency state;
- `architecture.source-dependencies` for observed source relationships.

The complete contract, compatibility, and migration rules are defined by
[Executable capabilities](executable-capabilities.md).

The foundation is not a production dependency and is not a shared business
kernel.
