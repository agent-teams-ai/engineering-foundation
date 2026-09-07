import { unstableFactoryBindings } from "./factory-stability.mjs";

// Prove emitted named-symbol availability without ownership or callable projection. The
// worklist adds only static (module, exported name) facts. Erased aliases remain
// available for symbol queries, but cannot suppress effects through a star.
function runtimeAvailability(sources, importTargets) {
  const names = new Map([...sources.keys()].map((path) => [path, new Set()]));
  const dependents = new Map(), pending = [...sources.keys()], queued = new Set(pending);
  function available(path, binding) {
    if (binding.runtimeAvailable !== undefined) {return binding.runtimeAvailable;}
    const imported = !binding.source && sources.get(path).imports.get(binding.runtimeLocal);
    const source = binding.source ?? imported?.node.source, name = binding.source ? binding.local : imported?.name;
    const targets = source ? importTargets(path, source) : [];
    return targets.length > 0 && targets.every((target) => names.get(target)?.has(name));
  }
  for (const [path, surface] of sources) {
    for (const source of [...surface.stars, ...[...surface.exports.values()].map((binding) =>
      binding.source ?? surface.imports.get(binding.runtimeLocal)?.node.source).filter(Boolean)]) {
      for (const target of importTargets(path, source)) {
        if (!dependents.has(target)) {dependents.set(target, new Set());}
        dependents.get(target).add(path);
      }
    }
  }
  for (const path of pending) {
    queued.delete(path);
    const surface = sources.get(path), present = names.get(path), before = present.size;
    for (const [name, binding] of surface.exports) {if (available(path, binding)) {present.add(name);}}
    for (const source of surface.stars) {
      const targets = importTargets(path, source);
      for (const name of names.get(targets[0]) ?? []) {
        // Named aliases select the explicit symbol even when it is erased;
        // namespace runtime stars are enumerated separately by starNames.
        if (name !== "default" && !surface.exports.has(name) && !surface.typeExports.has(name) &&
            targets.every((target) => names.get(target)?.has(name))) {present.add(name);}
      }
    }
    if (present.size !== before) {
      for (const dependent of dependents.get(path) ?? []) {
        if (!queued.has(dependent)) {queued.add(dependent); pending.push(dependent);}
      }
    }
  }
  return available;
}

// Enumerate candidate names only along accepted runtime star edges. Actual name
// transport below still applies explicit shadowing at every module. This finite
// traversal does not project values or allocate invocation frames.
function starNames(path, sources, importTargets) {
  const pending = [path], seen = new Set(), names = new Set();
  for (const current of pending) {
    if (seen.has(current)) {continue;}
    seen.add(current);
    const surface = sources.get(current);
    for (const [name, binding] of surface?.exports ?? []) {
      if (!binding.typeOnly && (current === path || name !== "default")) {names.add(name);}
    }
    for (const source of surface?.stars ?? []) {pending.push(...importTargets(current, source));}
  }
  return names;
}

/** Close module-owned escape facts before any ownership query observes them.
 * This transports the scanner's effects, not JavaScript execution or call results.
 */
export function stabilizeModuleFrames(sources, moduleFrame, importTargets) {
  const pending = [], seen = new Set(), declarations = new Map();
  const runtimeAvailable = runtimeAvailability(sources, importTargets);
  function enqueue(kind, path, name, reason) {
    const key = JSON.stringify([kind, path, name, reason]);
    if (seen.has(key)) {return;}
    seen.add(key);
    pending.push({ kind, path, name, reason });
  }
  function bindingEffect(path, name, reason) {
    const locals = moduleFrame(path), value = locals.get(name);
    if (!value) {return;}
    locals.set(name, { ...value, [reason]: true });
    // Replacing an alias does not replace its source binding.
    if (reason !== "unstable") {enqueue("binding", path, name, reason);}
  }
  function scan(path, body, escapes = []) {
    for (const [name, effects] of unstableFactoryBindings(body, moduleFrame(path), escapes)) {
      for (const reason of Object.keys(effects)) {bindingEffect(path, name, reason);}
    }
  }
  function importedEffect(path, source, name, reason) {
    for (const target of importTargets(path, source)) {enqueue("export", target, name, reason);}
  }
  function exportedEffect(path, name, reason) {
    const surface = sources.get(path);
    if (name === "*") {
      for (const exported of starNames(path, sources, importTargets)) {enqueue("export", path, exported, reason);}
      return;
    }
    const binding = surface?.exports.get(name);
    if (!binding || !runtimeAvailable(path, binding)) {
      // Erased declarations cannot shadow runtime stars. Ambiguous candidates
      // all receive the effect: missing precise projection never authorizes a
      // supposedly unaffected capture. A star never forwards the default name.
      if (name !== "default") {
        for (const source of surface?.stars ?? []) {importedEffect(path, source, name, reason);}
      }
      if (!binding || binding.runtimeAvailable === false) {return;}
    }
    if (binding.source) {importedEffect(path, binding.source, binding.local, reason);}
    else if (binding.declaration) {
      if (!declarations.has(path)) {declarations.set(path, {});}
      declarations.get(path)[reason] = true;
      scan(path, [], [[binding.declaration, reason]]);
    }
    else {bindingEffect(path, binding.local, reason);}
  }
  // Include side-effect-only consumers, even when no exported name leads to them.
  // All frames exist before scanning; no lazy cache can hide a later mutation.
  const paths = [...sources.keys()].toSorted();
  for (const path of paths) {moduleFrame(path);}
  for (const path of paths) {scan(path, sources.get(path).program.body);}
  // Monotonic finite worklist: each (module binding/export, escape reason) is
  // visited once. Import cycles cannot grow invocation frames or the fact set.
  for (const { kind, path, name, reason } of pending) {
    if (kind === "export") {exportedEffect(path, name, reason); continue;}
    const value = moduleFrame(path).get(name);
    if (value.imported) {
      // Type-only names cannot receive runtime writes or result escapes.
      if (value.imported.runtimeAvailable !== false) {importedEffect(path, value.imported.node.source, value.imported.name, reason);}
    }
    else {scan(path, [], [[value.node, reason]]);}
  }
  return declarations;
}
