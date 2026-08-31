import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

export function importedSpecifiers(source) {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
}

export function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) {return;}
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

export function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function pathsContaining(value, packageNames, path = []) {
  if (typeof value === "string") {
    const evidence = [...path, value].join(" ");
    return packageNames.every((name) => evidence.includes(name)) ? [path.join(".")] : [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return [];}
  return Object.entries(value).flatMap(([key, entry]) => {
    const next = [...path, key];
    const evidence = next.join(" ");
    const here = packageNames.every((name) => evidence.includes(name)) ? [next.join(".")] : [];
    return [...here, ...pathsContaining(entry, packageNames, next)];
  });
}
