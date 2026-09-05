import { unstableFactoryBindings } from "./factory-stability.mjs";

function typeOnlyImport(binding, name) {
  return binding.node.importKind === "type" || binding.node.specifiers.some((item) => item.local.name === name && item.importKind === "type");
}

/** Close module-owned escape facts before any ownership query observes them.
 * This transports the scanner's effects, not JavaScript execution or call results.
 */
export function stabilizeModuleFrames(sources, moduleFrame, importTargets) {
  const pending = [], seen = new Set(), declarations = new Map();
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
      for (const exported of surface?.exports.keys() ?? []) {enqueue("export", path, exported, reason);}
      return;
    }
    const binding = surface?.exports.get(name);
    if (!binding || binding.typeOnly) {return;}
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
      if (!typeOnlyImport(value.imported, name)) {importedEffect(path, value.imported.node.source, value.imported.name, reason);}
    }
    else {scan(path, [], [[value.node, reason]]);}
  }
  return declarations;
}
