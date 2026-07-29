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

The foundation is not a production dependency and is not a shared business
kernel.
