import assert from "node:assert/strict";
import test from "node:test";

import { collectUnchangedPublicTypeBindings } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/default-type-argument-equivalence.js";
import { classifyPublicApiChange } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/policies/evaluate-public-api-compatibility.js";
import { currentBaseline, sha256 } from "./support/public-api-fixtures.mjs";

const FACTORY_ALIAS_REFERENCE = "@fixture/public-api!AnyFactoryHandle:type";
const FACTORY_TARGET_REFERENCE = "@fixture/public-api!FactoryHandle:interface";

function typeAlias(signature) {
  return {
    canonicalReference: FACTORY_ALIAS_REFERENCE,
    kind: "TypeAlias",
    parentReference: "@fixture/public-api!",
    parentKind: "EntryPoint",
    signature,
  };
}

function genericTarget(
  signature = "export interface FactoryHandle<C, D extends ModuleDeclaration = ModuleDeclaration, I = unknown>",
  canonicalReference = FACTORY_TARGET_REFERENCE,
) {
  return {
    canonicalReference,
    kind: "Interface",
    parentReference: "@fixture/public-api!",
    parentKind: "EntryPoint",
    signature,
  };
}

function namedType(
  name = "ModuleDeclaration",
  canonicalReference = `@fixture/public-api!${name}:interface`,
) {
  return {
    canonicalReference,
    kind: "Interface",
    parentReference: "@fixture/public-api!",
    parentKind: "EntryPoint",
    signature: `export interface ${name}`,
  };
}

function namedEnum(
  name = "ModuleKind",
  canonicalReference = `@fixture/public-api!${name}:enum`,
) {
  return {
    canonicalReference,
    kind: "Enum",
    parentReference: "@fixture/public-api!",
    parentKind: "EntryPoint",
    signature: `export declare enum ${name}`,
  };
}

function snapshot(packageName, items) {
  return {
    schemaVersion: 1,
    packageName,
    packageVersion: "1.0.0",
    extractorVersion: "fixture",
    entrypoints: [{ exportPath: ".", items }],
  };
}

function defaultArgumentChange(releasedAlias, currentAlias, options = {}) {
  const releasedTarget = options.releasedTarget ?? genericTarget();
  const currentTarget = options.currentTarget ?? releasedTarget;
  const releasedExtras = options.releasedExtras ?? [namedType()];
  const currentExtras = options.currentExtras ?? releasedExtras;
  const released = {
    ...currentBaseline(),
    entrypoints: [{
      exportPath: ".",
      items: [typeAlias(releasedAlias), releasedTarget, ...releasedExtras],
    }],
  };
  const current = {
    ...released,
    entrypoints: [{
      exportPath: ".",
      items: [typeAlias(currentAlias), currentTarget, ...currentExtras],
    }],
  };
  return classifyPublicApiChange(
    released,
    current,
    { sha256 },
    options.stableTypeBindings,
  );
}

test("treats only exact trailing declared default type arguments as unchanged", () => {
  const explicit = "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;";
  const omitted = "export type AnyFactoryHandle<C> = FactoryHandle<C>;";

  assert.equal(defaultArgumentChange(explicit, omitted).classification, "none");
  assert.equal(defaultArgumentChange(omitted, explicit).classification, "none");
  assert.equal(
    defaultArgumentChange(
      explicit,
      "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration>;",
    ).classification,
    "none",
  );
});

test("rejects unproved default-type-argument equivalence", () => {
  const explicit = "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;";
  const rejectingChanges = [
    ["export type AnyFactoryHandle<C> = FactoryHandle<C, DifferentDeclaration, unknown>;", {}],
    ["export type AnyFactoryHandle<C> = FactoryHandle<C, unknown>;", {}],
    ["export type AnyFactoryHandle<C> = OtherFactoryHandle<C>;", {}],
    ["export type RenamedFactoryHandle<C> = FactoryHandle<C>;", {}],
    ["export type AnyFactoryHandle<C> = Readonly<FactoryHandle<C>>;", {}],
    [
      "export type AnyFactoryHandle<C> = FactoryHandle<C>;",
      {
        releasedTarget: genericTarget(
          "export interface FactoryHandle<C, M extends ModuleDeclaration, Output = unknown>",
        ),
      },
    ],
    [
      "export type AnyFactoryHandle<C> = FactoryHandle<C>;",
      {
        releasedExtras: [genericTarget(undefined, "@fixture/public-api!FactoryHandle_2:interface")],
        currentExtras: [genericTarget(undefined, "@fixture/public-api!FactoryHandle_2:interface")],
      },
    ],
  ];

  for (const [current, options] of rejectingChanges) {
    assert.equal(
      defaultArgumentChange(explicit, current, options).classification,
      "breaking",
      current,
    );
  }
});

test("rejects defaults whose meaning can depend on target parameter bindings", () => {
  const target = {
    ...genericTarget(
      "export type F<T, U = T> = readonly [T, U]",
      "@fixture/public-api!F:type",
    ),
    kind: "TypeAlias",
  };
  const explicit = "export type AnyFactoryHandle<T> = F<string, T>;";
  const omitted = "export type AnyFactoryHandle<T> = F<string>;";

  assert.equal(
    defaultArgumentChange(explicit, omitted, { releasedTarget: target }).classification,
    "breaking",
  );
  assert.equal(
    defaultArgumentChange(omitted, explicit, { releasedTarget: target }).classification,
    "breaking",
  );
});

test("rejects defaults shadowed by alias type parameters", () => {
  const explicit =
    "export type AnyFactoryHandle<C, ModuleDeclaration> = FactoryHandle<C, ModuleDeclaration>;";
  const omitted =
    "export type AnyFactoryHandle<C, ModuleDeclaration> = FactoryHandle<C>;";

  assert.equal(defaultArgumentChange(explicit, omitted).classification, "breaking");
  assert.equal(defaultArgumentChange(omitted, explicit).classification, "breaking");
});

test("rejects malformed and unsupported alias type-parameter headers", () => {
  const cases = [
    [
      "export type AnyFactoryHandle<C = > = FactoryHandle<C, ModuleDeclaration, unknown>;",
      "export type AnyFactoryHandle<C = > = FactoryHandle<C>;",
    ],
    [
      "export type AnyFactoryHandle<C extends object & object> = FactoryHandle<C, ModuleDeclaration, unknown>;",
      "export type AnyFactoryHandle<C extends object & object> = FactoryHandle<C>;",
    ],
    [
      "export type AnyFactoryHandle<C = object, D> = FactoryHandle<C, ModuleDeclaration, unknown>;",
      "export type AnyFactoryHandle<C = object, D> = FactoryHandle<C>;",
    ],
  ];

  for (const [explicit, omitted] of cases) {
    assert.equal(defaultArgumentChange(explicit, omitted).classification, "breaking");
    assert.equal(defaultArgumentChange(omitted, explicit).classification, "breaking");
  }
});

test("rejects operator and reserved words in alias type parameters", () => {
  const target = {
    ...genericTarget(
      "export type F<T = string> = T",
      "@fixture/public-api!F:type",
    ),
    kind: "TypeAlias",
  };
  const cases = [
    [
      "export type A<C extends keyof> = F<string>;",
      "export type A<C extends keyof> = F;",
    ],
    ["export type A<C = keyof> = F<string>;", "export type A<C = keyof> = F;"],
    ["export type A<default> = F<string>;", "export type A<default> = F;"],
  ];

  for (const [explicit, omitted] of cases) {
    assert.equal(
      defaultArgumentChange(explicit, omitted, { releasedTarget: target })
        .classification,
      "breaking",
    );
    assert.equal(
      defaultArgumentChange(omitted, explicit, { releasedTarget: target })
        .classification,
      "breaking",
    );
  }
});

test("rejects target names shadowed by alias type parameters", () => {
  const target = {
    ...genericTarget(
      "export type F<T = string> = T",
      "@fixture/public-api!F:type",
    ),
    kind: "TypeAlias",
  };
  const explicit = "export type A<F> = F<string>;";
  const omitted = "export type A<F> = F;";

  assert.equal(
    defaultArgumentChange(explicit, omitted, { releasedTarget: target })
      .classification,
    "breaking",
  );
  assert.equal(
    defaultArgumentChange(omitted, explicit, { releasedTarget: target })
      .classification,
    "breaking",
  );
});

test("rejects default atoms without an unchanged public binding", () => {
  const explicit = "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;";
  const omitted = "export type AnyFactoryHandle<C> = FactoryHandle<C>;";
  const changedBinding = namedType(
    "ModuleDeclaration",
    "@fixture/public-api!OtherModuleDeclaration:interface",
  );

  assert.equal(
    defaultArgumentChange(explicit, omitted, { currentExtras: [changedBinding] })
      .classification,
    "breaking",
  );
  assert.equal(
    defaultArgumentChange(omitted, explicit, { currentExtras: [changedBinding] })
      .classification,
    "breaking",
  );
  assert.equal(
    defaultArgumentChange(explicit, omitted, { currentExtras: [] }).classification,
    "breaking",
  );
});

test("accepts a unique unchanged binding supplied by the governed package set", () => {
  const explicit = "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;";
  const omitted = "export type AnyFactoryHandle<C> = FactoryHandle<C>;";
  const releasedBinding = namedType();
  const stableTypeBindings = collectUnchangedPublicTypeBindings([{
    released: snapshot("@fixture/core", [releasedBinding]),
    current: snapshot("@fixture/core", [releasedBinding]),
  }]);
  const options = {
    releasedExtras: [],
    currentExtras: [],
    stableTypeBindings,
  };

  assert.deepEqual([...stableTypeBindings], ["ModuleDeclaration"]);
  assert.equal(defaultArgumentChange(explicit, omitted, options).classification, "none");
  assert.equal(defaultArgumentChange(omitted, explicit, options).classification, "none");
  assert.equal(
    collectUnchangedPublicTypeBindings([{
      released: snapshot("@fixture/core", [releasedBinding]),
      current: snapshot("@fixture/core", [namedType(
        "ModuleDeclaration",
        "@fixture/core!RenamedModuleDeclaration:interface",
      )]),
    }]).has("ModuleDeclaration"),
    false,
  );
});

test("accepts defaults on unchanged declared abstract classes", () => {
  const target = {
    ...genericTarget(
      "export declare abstract class FactoryHandle<C, D extends ModuleDeclaration = ModuleDeclaration, I = unknown>",
    ),
    kind: "Class",
  };
  const explicit =
    "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;";
  const omitted = "export type AnyFactoryHandle<C> = FactoryHandle<C>;";

  assert.equal(
    defaultArgumentChange(explicit, omitted, { releasedTarget: target })
      .classification,
    "none",
  );
  assert.equal(
    defaultArgumentChange(omitted, explicit, { releasedTarget: target })
      .classification,
    "none",
  );
});

test("accepts an unchanged exported enum as a default binding", () => {
  const target = genericTarget(
    "export interface FactoryHandle<C, D extends ModuleKind = ModuleKind, I = unknown>",
  );
  const explicit =
    "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleKind, unknown>;";
  const omitted = "export type AnyFactoryHandle<C> = FactoryHandle<C>;";
  const binding = namedEnum();
  const options = {
    releasedTarget: target,
    releasedExtras: [binding],
    currentExtras: [binding],
  };

  assert.equal(defaultArgumentChange(explicit, omitted, options).classification, "none");
  assert.equal(defaultArgumentChange(omitted, explicit, options).classification, "none");
});

test("rejects unsupported atoms in direct alias arguments", () => {
  const explicit =
    "export type AnyFactoryHandle<C> = FactoryHandle<keyof, ModuleDeclaration, unknown>;";
  const omitted = "export type AnyFactoryHandle<C> = FactoryHandle<keyof>;";

  assert.equal(defaultArgumentChange(explicit, omitted).classification, "breaking");
  assert.equal(defaultArgumentChange(omitted, explicit).classification, "breaking");
});

test("requires exact alias headers in both directions", () => {
  const left =
    "export type AnyFactoryHandle<C> = FactoryHandle<C, ModuleDeclaration, unknown>;";
  const right = "export type AnyFactoryHandle<D> = FactoryHandle<C>;";

  assert.equal(defaultArgumentChange(left, right).classification, "breaking");
  assert.equal(defaultArgumentChange(right, left).classification, "breaking");
});
