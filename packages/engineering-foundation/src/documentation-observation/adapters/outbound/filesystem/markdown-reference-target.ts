type UnsafeReferenceReason = "absolute-path" | "invalid-encoding";

export type MarkdownReferenceTarget =
  | { readonly kind: "external" }
  | {
      readonly kind: "local";
      readonly fragment: string;
      readonly target: string;
    }
  | {
      readonly kind: "unsafe";
      readonly reason: UnsafeReferenceReason;
    };

interface SplitReferenceTarget {
  readonly fragment: string;
  readonly target: string;
}

function splitTargetAndFragment(rawTarget: string): SplitReferenceTarget {
  let escapedCharacter = false;
  for (let index = 0; index < rawTarget.length; index += 1) {
    const character = rawTarget[index];
    if (escapedCharacter) {
      escapedCharacter = false;
      continue;
    }
    if (character === "\\") {
      escapedCharacter = true;
      continue;
    }
    if (character === "#") {
      return {
        fragment: rawTarget.slice(index + 1),
        target: rawTarget.slice(0, index)
      };
    }
  }
  return { fragment: "", target: rawTarget };
}

function decodeMarkdownDestination(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\\(.)/gu, "$1"));
  } catch {
    return undefined;
  }
}

function isExternalReference(target: string): boolean {
  return target.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target);
}

function isFileOrDriveAbsoluteReference(target: string): boolean {
  return (
    target.toLowerCase().startsWith("file:") ||
    /^[A-Za-z]:[\\/]/u.test(target)
  );
}

export function parseMarkdownReferenceTarget(
  rawTarget: string
): MarkdownReferenceTarget {
  const split = splitTargetAndFragment(rawTarget);
  const target = decodeMarkdownDestination(split.target);
  const fragment = decodeMarkdownDestination(split.fragment);
  if (target === undefined || fragment === undefined) {
    return { kind: "unsafe", reason: "invalid-encoding" };
  }
  if (isFileOrDriveAbsoluteReference(target)) {
    return { kind: "unsafe", reason: "absolute-path" };
  }
  if (isExternalReference(target)) {
    return { kind: "external" };
  }
  if (target.includes("\\") || target.startsWith("/")) {
    return { kind: "unsafe", reason: "absolute-path" };
  }
  return { fragment, kind: "local", target };
}

export function stripMarkdownReferenceQuery(target: string): string {
  const queryStart = target.indexOf("?");
  return queryStart === -1 ? target : target.slice(0, queryStart);
}
