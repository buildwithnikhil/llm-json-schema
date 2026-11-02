/** The schema has no faithful equivalent for the target. `path` points into the original schema. */
export class UnsupportedSchemaError extends Error {
  override name = "UnsupportedSchemaError";
  constructor(
    readonly path: string,
    readonly target: string,
    readonly reason: string,
    readonly suggestion?: string,
  ) {
    super(`${target}: ${reason} at ${path}${suggestion ? `. ${suggestion}` : ""}`);
  }
}
