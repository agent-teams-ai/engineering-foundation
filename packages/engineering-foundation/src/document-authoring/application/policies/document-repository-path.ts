const DOCUMENT_REPOSITORY_PATH =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\.(?:\/|$))(?!.*(?:^|\/)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[A-Za-z0-9._@-]*)?(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/iu;

export function isDocumentRepositoryPath(path: string): boolean {
  return path.length <= 512 && DOCUMENT_REPOSITORY_PATH.test(path);
}
