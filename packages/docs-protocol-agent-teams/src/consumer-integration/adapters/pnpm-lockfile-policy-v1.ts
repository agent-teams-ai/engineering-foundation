export function validPnpmPeerContext(value: unknown, exactVersion: string): value is string {
  if (value === exactVersion) {return true;}
  if (typeof value !== "string" || !value.startsWith(`${exactVersion}(`)) {return false;}
  const contentByDepth: boolean[] = [];
  for (const character of value.slice(exactVersion.length)) {
    if (character === "(") {
      contentByDepth.push(false);
    } else if (character === ")") {
      if (contentByDepth.pop() !== true) {return false;}
      if (contentByDepth.length > 0) {contentByDepth[contentByDepth.length - 1] = true;}
    } else {
      if (contentByDepth.length === 0 || /\s/u.test(character)) {return false;}
      contentByDepth[contentByDepth.length - 1] = true;
    }
  }
  return contentByDepth.length === 0;
}

export function targetsManagedPackage(
  value: unknown,
  packageNames: readonly string[]
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return false;}
  return Object.keys(value).some((key) =>
    packageNames.some((packageName) => key.includes(packageName))
  );
}
