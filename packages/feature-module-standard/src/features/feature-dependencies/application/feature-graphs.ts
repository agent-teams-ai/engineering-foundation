export type Edge = readonly [from: string, to: string];

/** Cycles of a directed graph as `[a, b, a]` paths, found depth first over sorted nodes; self loops are ignored. */
export function findCycles(edges: Iterable<Edge>): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (from === to) {
      continue;
    }
    graph.set(from, (graph.get(from) ?? new Set<string>()).add(to));
  }
  const active: string[] = [];
  const complete = new Set<string>();
  const found: string[][] = [];
  const visit = (node: string): void => {
    const position = active.indexOf(node);
    if (position >= 0) {
      found.push([...active.slice(position), node]);
      return;
    }
    if (complete.has(node)) {
      return;
    }
    active.push(node);
    for (const target of [...(graph.get(node) ?? [])].toSorted()) {
      visit(target);
    }
    active.pop();
    complete.add(node);
  };
  for (const node of [...graph.keys()].toSorted()) {
    visit(node);
  }
  return found;
}

/** Strongly connected components with more than one node, each sorted, in a stable order. */
export function cyclicComponents(edges: readonly Edge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const targets = graph.get(from) ?? [];
    targets.push(to);
    graph.set(from, targets);
    if (!graph.has(to)) {
      graph.set(to, []);
    }
  }
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const lowOf = (node: string): number => low.get(node) ?? 0;
  for (const root of [...graph.keys()].toSorted()) {
    if (order.has(root)) {
      continue;
    }
    const work = [{ node: root, next: 0 }];
    order.set(root, order.size);
    low.set(root, order.get(root) ?? 0);
    stack.push(root);
    onStack.add(root);
    for (let frame = work.at(-1); frame !== undefined; frame = work.at(-1)) {
      const target = graph.get(frame.node)?.[frame.next];
      if (target !== undefined) {
        frame.next += 1;
        if (!order.has(target)) {
          order.set(target, order.size);
          low.set(target, order.get(target) ?? 0);
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(lowOf(frame.node), order.get(target) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent !== undefined) {
        low.set(parent.node, Math.min(lowOf(parent.node), lowOf(frame.node)));
      }
      if (lowOf(frame.node) === order.get(frame.node)) {
        const component = stack.splice(stack.indexOf(frame.node));
        for (const member of component) {
          onStack.delete(member);
        }
        if (component.length > 1) {
          components.push(component.toSorted());
        }
      }
    }
  }
  return components.toSorted((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));
}
