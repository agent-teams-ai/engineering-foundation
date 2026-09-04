import { extname, relative, resolve, sep } from "node:path";

import { sha256 } from "./pack-artifact-archive.mjs";

function fail(reason) { throw new Error(`Markdown canonical graph is invalid: ${reason}.`); }

function sortEntries(entries) {
  return entries.toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

// Filesystem placement is not module identity. Collapse only copies with the
// same authenticated bytes AND exactly the same resolved outgoing edges.
export function canonicalMarkdownGraph({ captured, entry, identities, metafile, packageRoot }) {
  const keys = new Map([...captured].map(([path, input]) => {
    if (path === entry) { return [path, "markdown-entry.js"]; }
    const identity = identities.get(input.root);
    if (identity === undefined) { fail("input has no authenticated component"); }
    return [path, `${identity.name}@${identity.version}/${relative(input.root, path).split(sep).join("/")}`];
  }));
  const nodes = new Map();
  for (const [physicalPath, input] of captured) {
    const metadata = metafile.inputs[relative(packageRoot, physicalPath).split(sep).join("/")];
    if (metadata === undefined) { fail("input metadata is missing"); }
    const imports = new Map(metadata.imports.map((item) => {
      const target = item.external ? item.path : keys.get(resolve(packageRoot, item.path));
      if (target === undefined) { fail("resolved edge escapes the captured graph"); }
      return [`${item.kind}:${item.original ?? item.path}`, { path: target, external: item.external === true }];
    }));
    const identity = identities.get(input.root);
    const descriptor = {
      inputSha256: sha256(input.bytes), manifestSha256: identity?.manifestSha256 ?? null,
      format: metadata.format ?? null, imports: sortEntries([...imports]),
    };
    const key = keys.get(physicalPath);
    const previous = nodes.get(key);
    if (previous !== undefined && JSON.stringify(previous.descriptor) !== JSON.stringify(descriptor)) {
      fail(`copies have different bytes, metadata or dependency resolutions: ${key}`);
    }
    nodes.set(key, { bytes: input.bytes, descriptor, imports });
  }
  const digest = sha256(JSON.stringify(sortEntries([...nodes]).map(([key, node]) => [key, node.descriptor])));
  return { digest, entry: keys.get(entry), nodes };
}

export function canonicalMarkdownPlugin(graph) {
  return {
    name: "closed-markdown-graph",
    setup(builder) {
      // These filters run in Go, which does not accept JavaScript's u flag.
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") { return { path: graph.entry, namespace: "markdown" }; }
        const target = graph.nodes.get(args.importer)?.imports.get(`${args.kind}:${args.path}`);
        if (target === undefined) { fail("undiscovered resolution requested during emission"); }
        return target.external ? { path: target.path, external: true } : { path: target.path, namespace: "markdown" };
      });
      builder.onLoad({ filter: /.*/, namespace: "markdown" }, ({ path }) => {
        const node = graph.nodes.get(path);
        if (node === undefined) { fail("undiscovered source requested during emission"); }
        return { contents: node.bytes, loader: extname(path) === ".json" ? "json" : "js" };
      });
    },
  };
}
