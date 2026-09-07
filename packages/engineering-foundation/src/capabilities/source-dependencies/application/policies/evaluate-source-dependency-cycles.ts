import {
  compareBinaryStrings,
  compareBinaryStringSequences
} from "../../../../binary-string-comparator.js";
import type { DiagnosticEvidence, FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type {
  ObservedSourceDependencyEdge,
  ObservedSourceGraph,
  SourceDependencyEdgeMode
} from "../model/source-workspace.js";
import {
  SOURCE_DEPENDENCY_RULES,
  type SourceDependencyRuleMetadata
} from "../rules.js";

type CycleScope = "boundary" | "package";

interface LogicalEdge {
  readonly from: string;
  readonly mode: SourceDependencyEdgeMode;
  readonly to: string;
  readonly sourcePath: string;
  readonly targetPath: string | null;
}

interface CycleEvidence {
  readonly members: readonly string[];
  readonly witness: readonly LogicalEdge[];
}

const MAX_EVIDENCE_MEMBERS = 16;
const MAX_EVIDENCE_WITNESS_NODES = 16;

function diagnostic(input: {
  readonly rule: SourceDependencyRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly path: string;
  readonly relatedPath: string | null;
  readonly evidence: readonly DiagnosticEvidence[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.path },
    relatedLocations:
      input.relatedPath === null ? [] : [{ path: input.relatedPath }],
    evidence: input.evidence,
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function compareLogicalEdges(left: LogicalEdge, right: LogicalEdge): number {
  return (
    compareBinaryStrings(left.from, right.from) ||
    compareBinaryStrings(left.to, right.to) ||
    compareBinaryStrings(left.mode, right.mode) ||
    compareBinaryStrings(left.sourcePath, right.sourcePath) ||
    compareBinaryStrings(left.targetPath ?? "", right.targetPath ?? "")
  );
}

function logicalEdges(
  graph: ObservedSourceGraph,
  scope: CycleScope,
  mode: SourceDependencyEdgeMode
): readonly LogicalEdge[] {
  const candidates: LogicalEdge[] = [];
  for (const edge of graph.edges) {
    // A runtime cycle may contain type-only edges. Type-only diagnostics stay
    // strict so a purely type-level SCC is not reported as a runtime cycle.
    if (mode === "type-only" && edge.mode !== "type-only") {
      continue;
    }
    const candidate = logicalEdge(edge, scope);
    if (candidate !== undefined && candidate.from !== candidate.to) {
      candidates.push(candidate);
    }
  }
  const unique = new Map<string, LogicalEdge>();
  for (const edge of candidates.toSorted(compareLogicalEdges)) {
    const key = `${edge.from}\u0000${edge.to}`;
    const current = unique.get(key);
    if (current === undefined || (current.mode === "type-only" && edge.mode === "runtime")) {
      unique.set(key, edge);
    }
  }
  return Object.freeze([...unique.values()].toSorted(compareLogicalEdges));
}

function logicalEdge(
  edge: ObservedSourceDependencyEdge,
  scope: CycleScope
): LogicalEdge | undefined {
  if (scope === "boundary") {
    if (edge.resolution.kind !== "local-file") {
      return undefined;
    }
    if (edge.resolution.targetBoundaryId === null) {
      return undefined;
    }
    return {
      from: edge.fromBoundaryId,
      mode: edge.mode,
      to: edge.resolution.targetBoundaryId,
      sourcePath: edge.fromPath,
      targetPath: edge.resolution.path
    };
  }

  switch (edge.resolution.kind) {
    case "local-file":
      return {
        from: edge.fromWorkspacePackageName,
        mode: edge.mode,
        to: edge.resolution.workspacePackageName,
        sourcePath: edge.fromPath,
        targetPath: edge.resolution.path
      };
    case "workspace-package":
      return {
        from: edge.fromWorkspacePackageName,
        mode: edge.mode,
        to: edge.resolution.workspacePackageName,
        sourcePath: edge.fromPath,
        targetPath: null
      };
    case "builtin":
    case "external-package":
    case "self-workspace-package":
    case "generated-output-candidate":
    case "unresolved":
    case "unsupported":
      return undefined;
  }
}

function adjacency(edges: readonly LogicalEdge[]): ReadonlyMap<string, readonly LogicalEdge[]> {
  const output = new Map<string, LogicalEdge[]>();
  for (const edge of edges) {
    const from = output.get(edge.from) ?? [];
    from.push(edge);
    output.set(edge.from, from);
    if (!output.has(edge.to)) {
      output.set(edge.to, []);
    }
  }
  return new Map(
    [...output.entries()].map(([node, outgoing]) => [
      node,
      Object.freeze(outgoing.toSorted(compareLogicalEdges))
    ])
  );
}

function stronglyConnectedComponents(
  graph: ReadonlyMap<string, readonly LogicalEdge[]>
): readonly (readonly string[])[] {
  interface TraversalFrame {
    readonly node: string;
    nextEdgeIndex: number;
  }

  const nodes = [...graph.keys()].toSorted();
  const visited = new Set<string>();
  const finished: string[] = [];

  // Iterative DFS avoids call-stack failure on a large workspace graph.
  for (const start of nodes) {
    if (visited.has(start)) {
      continue;
    }
    visited.add(start);
    const stack: TraversalFrame[] = [{ node: start, nextEdgeIndex: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      const edge = (graph.get(frame.node) ?? [])[frame.nextEdgeIndex];
      if (edge === undefined) {
        finished.push(frame.node);
        stack.pop();
        continue;
      }
      frame.nextEdgeIndex += 1;
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        stack.push({ node: edge.to, nextEdgeIndex: 0 });
      }
    }
  }

  const reversed = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const [from, outgoing] of graph) {
    for (const edge of outgoing) {
      const predecessors = reversed.get(edge.to);
      if (predecessors !== undefined) {
        predecessors.push(from);
      }
    }
  }
  const reverseAdjacency = new Map(
    [...reversed.entries()].map(([node, predecessors]) => [
      node,
      predecessors.toSorted()
    ])
  );

  const components: string[][] = [];
  visited.clear();
  for (const start of finished.toReversed()) {
    if (visited.has(start)) {
      continue;
    }
    const component: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        continue;
      }
      component.push(node);
      for (const predecessor of reverseAdjacency.get(node) ?? []) {
        if (!visited.has(predecessor)) {
          visited.add(predecessor);
          stack.push(predecessor);
        }
      }
    }
    if (component.length > 1) {
      components.push(component.toSorted());
    }
  }
  return Object.freeze(
    components.toSorted(compareBinaryStringSequences)
  );
}

function shortestPath(
  start: string,
  target: string,
  members: ReadonlySet<string>,
  graph: ReadonlyMap<string, readonly LogicalEdge[]>,
  requiredMode?: SourceDependencyEdgeMode
): readonly LogicalEdge[] | undefined {
  const queue = [start];
  const previous = new Map<string, LogicalEdge>();
  const visited = new Set([start]);
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (node === undefined) {
      break;
    }
    for (const edge of graph.get(node) ?? []) {
      if (
        (requiredMode !== undefined && edge.mode !== requiredMode) ||
        !members.has(edge.to) ||
        visited.has(edge.to)
      ) {
        continue;
      }
      previous.set(edge.to, edge);
      if (edge.to === target) {
        return reconstructPath(previous, start, target);
      }
      visited.add(edge.to);
      queue.push(edge.to);
    }
  }
  return undefined;
}

function reconstructPath(
  previous: ReadonlyMap<string, LogicalEdge>,
  start: string,
  target: string
): readonly LogicalEdge[] | undefined {
  const path: LogicalEdge[] = [];
  let cursor = target;
  while (cursor !== start) {
    const step = previous.get(cursor);
    if (step === undefined) {
      return undefined;
    }
    path.push(step);
    cursor = step.from;
  }
  return Object.freeze(path.toReversed());
}

function canonicalWitness(
  members: readonly string[],
  graph: ReadonlyMap<string, readonly LogicalEdge[]>,
  mode: SourceDependencyEdgeMode
): readonly LogicalEdge[] | undefined {
  if (members.length === 0) {
    return undefined;
  }
  const memberSet = new Set(members);
  const candidateEdges = mode === "runtime"
    ? members.flatMap((member) =>
        (graph.get(member) ?? []).filter(
          (edge) => edge.mode === "runtime" && memberSet.has(edge.to)
        )
      ).toSorted(compareLogicalEdges)
    : graph.get(members[0] ?? "") ?? [];
  if (mode === "runtime") {
    for (const firstEdge of candidateEdges) {
      const returnPath = shortestPath(
        firstEdge.to,
        firstEdge.from,
        memberSet,
        graph,
        "runtime"
      );
      if (returnPath !== undefined) {
        return Object.freeze([firstEdge, ...returnPath]);
      }
    }
  }
  for (const firstEdge of candidateEdges) {
    if (!memberSet.has(firstEdge.to)) {
      continue;
    }
    const returnPath = shortestPath(firstEdge.to, firstEdge.from, memberSet, graph);
    if (returnPath !== undefined) {
      return Object.freeze([firstEdge, ...returnPath]);
    }
  }
  return undefined;
}

function boundedList(values: readonly string[], maxItems: number): string {
  if (values.length <= maxItems) {
    return values.join(", ");
  }
  const headCount = Math.ceil(maxItems / 2);
  const tailCount = Math.floor(maxItems / 2);
  return [
    ...values.slice(0, headCount),
    `...(+${values.length - maxItems})`,
    ...values.slice(-tailCount)
  ].join(", ");
}

function boundedWitness(edges: readonly LogicalEdge[]): string {
  const nodes = [edges[0]?.from, ...edges.map((edge) => edge.to)].filter(
    (node): node is string => node !== undefined
  );
  if (nodes.length <= MAX_EVIDENCE_WITNESS_NODES) {
    return nodes.join(" -> ");
  }
  const headCount = Math.ceil(MAX_EVIDENCE_WITNESS_NODES / 2);
  const tailCount = Math.floor(MAX_EVIDENCE_WITNESS_NODES / 2);
  return [
    ...nodes.slice(0, headCount),
    "...",
    ...nodes.slice(-tailCount)
  ].join(" -> ");
}

function cycleEvidence(
  graph: ReadonlyMap<string, readonly LogicalEdge[]>,
  mode: SourceDependencyEdgeMode
): readonly CycleEvidence[] {
  const cycles: CycleEvidence[] = [];
  for (const members of stronglyConnectedComponents(graph)) {
    const witness = canonicalWitness(members, graph, mode);
    if (witness !== undefined) {
      cycles.push(Object.freeze({ members: Object.freeze([...members]), witness }));
    }
  }
  return Object.freeze(
    cycles.toSorted((left, right) =>
      compareBinaryStringSequences(left.members, right.members)
    )
  );
}

function ruleFor(
  scope: CycleScope,
  mode: SourceDependencyEdgeMode
): SourceDependencyRuleMetadata {
  if (scope === "boundary") {
    return mode === "runtime"
      ? SOURCE_DEPENDENCY_RULES.boundaryRuntimeCycle
      : SOURCE_DEPENDENCY_RULES.boundaryTypeOnlyCycle;
  }
  return mode === "runtime"
    ? SOURCE_DEPENDENCY_RULES.packageRuntimeCycle
    : SOURCE_DEPENDENCY_RULES.packageTypeOnlyCycle;
}

export function evaluateSourceDependencyCycles(
  graph: ObservedSourceGraph
): readonly FoundationDiagnostic[] {
  const diagnostics: FoundationDiagnostic[] = [];
  for (const scope of ["boundary", "package"] as const) {
    for (const mode of ["runtime", "type-only"] as const) {
      const cycles = cycleEvidence(adjacency(logicalEdges(graph, scope, mode)), mode);
      const rule = ruleFor(scope, mode);
      for (const cycle of cycles) {
        const firstEdge = cycle.witness[0];
        if (firstEdge === undefined) {
          continue;
        }
        diagnostics.push(
          diagnostic({
            rule,
            subject: `${scope}:${cycle.members.join(",")}`,
            message: `Observed ${mode} ${scope} cycle: ${boundedWitness(cycle.witness)}.`,
            path: firstEdge.sourcePath,
            relatedPath: firstEdge.targetPath,
            evidence: [
              { kind: "cycle-scope", value: scope },
              { kind: "cycle-mode", value: mode },
              { kind: "cycle-members", value: boundedList(cycle.members, MAX_EVIDENCE_MEMBERS) },
              { kind: "cycle-size", value: String(cycle.members.length) },
              { kind: "cycle-witness", value: boundedWitness(cycle.witness) },
              { kind: "cycle-witness-edge-count", value: String(cycle.witness.length) }
            ]
          })
        );
      }
    }
  }
  return diagnostics;
}
