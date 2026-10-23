import {
  NativeDescriptorCollector,
  representedDeclarations,
  type Descriptor,
} from "./native-public-api-descriptors.js";
import * as ast from "typescript/unstable/ast";
import * as model from "@microsoft/api-extractor-model";
import { TSDocConfiguration, TSDocParser } from "@microsoft/tsdoc";
import { createNativeApiItem } from "./native-public-api-item.js";
import { externalReference, references } from "./native-public-api-reference.js";
import { assertNotCancelled } from "../../../application/policies/public-api-evidence-errors.js";
import {
  nativeCompilerDiagnostics,
  type NativePublicApiContext,
  type NativePublicApiDiagnostic,
} from "./native-public-api-engine.js";
import {
  combineNativeExcerpts,
  createNativeExcerpt,
  type NativeExcerptReference,
} from "./native-public-api-excerpt.js";

type Container = model.ApiItem & model.ApiItemContainerMixin;

/** Public model constructors retain ownership of identities, parents and overload
 * references. The native adapter owns only compiler observation and projection. */
export async function createNativePublicApiModel(
  context: NativePublicApiContext,
  options: {
    readonly packageName: string;
    readonly entryPointPath: string;
    readonly includeForgottenExports: boolean;
    readonly untrimmedObservation?: boolean;
    readonly referenceProjection?: "stored-surface" | "declaration-graph";
  },
): Promise<{
  readonly model: model.ApiModel;
  readonly apiPackage: model.ApiPackage;
  readonly diagnostics: readonly NativePublicApiDiagnostic[];
  readonly succeeded: boolean;
  readonly declarationBindings: ReadonlyMap<string, ast.Node>;
}> {
  const diagnostics: NativePublicApiDiagnostic[] = [...(await nativeCompilerDiagnostics(context))];
  const configuration = new TSDocConfiguration();
  const parser = new TSDocParser(configuration);
  const declarations = new Map<string, ast.Node>();
  const reported = new Set<string>();
  const problem = (id: string, text: string, node?: ast.Node, severity = "error"): void => {
    const key = `${id}:${text}:${node?.getSourceFile().fileName ?? ""}:${node?.pos ?? ""}`;
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    diagnostics.push({
      source: "extractor",
      id,
      severity,
      text,
      ...(node === undefined
        ? {}
        : {
            file: node.getSourceFile().fileName,
            line: node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1,
          }),
    });
  };
  const collector = new NativeDescriptorCollector(context, options, parser, problem);
  await collector.collect();
  const { roots, bySymbol } = collector;

  const instantiate = async (
    descriptor: Descriptor,
    bind: boolean,
  ): Promise<model.ApiDeclaredItem> => {
    const excerpts = [];
    for (const node of await representedDeclarations(context, descriptor)) {
      const boundReferences: NativeExcerptReference[] = [];
      if (bind) {
        for (const occurrence of await references(context, node, problem)) {
          const matches = bySymbol.get(occurrence.symbol.id) ?? [];
          const canonicalReference =
            matches.find((candidate) => candidate.name === occurrence.node.getText())
              ?.canonicalReference ??
            matches[0]?.canonicalReference ??
            (await externalReference(context, occurrence, options.packageName, problem));
          if (canonicalReference !== undefined && canonicalReference.length > 0) {
            boundReferences.push({
              start: occurrence.start,
              end: occurrence.end,
              canonicalReference,
            });
          }
        }
      }
      excerpts.push(await createNativeExcerpt(context, { ...descriptor, node }, boundReferences));
    }
    const projected = combineNativeExcerpts(excerpts);
    return createNativeApiItem(context, descriptor, projected);
  };
  const build = async (bind: boolean) => {
    const apiModel = new model.ApiModel();
    const apiPackage = new model.ApiPackage({
      name: options.packageName,
      docComment: undefined,
      tsdocConfiguration: configuration,
    });
    const entry = new model.ApiEntryPoint({ name: "" });
    apiModel.addMember(apiPackage);
    apiPackage.addMember(entry);
    const append = async (descriptor: Descriptor, parent: Container): Promise<void> => {
      const item = await instantiate(descriptor, bind);
      parent.addMember(item);
      descriptor.canonicalReference = item.canonicalReference.toString();
      declarations.set(descriptor.canonicalReference, descriptor.node);
      if (descriptor.children.length > 0) {
        if (!model.ApiItemContainerMixin.isBaseClassOf(item)) {
          throw new Error("Native model item cannot own declarations.");
        }
        for (const child of descriptor.children) {
          await append(child, item);
        }
      }
    };
    for (const descriptor of roots) {
      await append(descriptor, entry);
    }
    return { model: apiModel, apiPackage };
  };
  const unbound = await build(false);
  const result = options.referenceProjection === "stored-surface" ? unbound : await build(true);
  assertNotCancelled(context.signal);
  return {
    ...result,
    diagnostics,
    succeeded: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    declarationBindings: declarations,
  };
}
