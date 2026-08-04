export class ScaffoldAuthorityStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldAuthorityStaleError";
  }
}
