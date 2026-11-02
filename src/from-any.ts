import type { JSONSchema } from "./types.js";

interface StandardJSONSchema {
  "~standard": {
    jsonSchema: {
      input(options: { target: string }): unknown;
      output(options: { target: string }): unknown;
    };
  };
}

const isStandardJSONSchema = (v: unknown): v is StandardJSONSchema => {
  const std = (v as { "~standard"?: { jsonSchema?: { input?: unknown } } } | null)?.["~standard"];
  return typeof std === "object" && std !== null && typeof std.jsonSchema?.input === "function";
};

export interface FromAnyOptions {
  /**
   * For schema libraries: "input" describes what the schema accepts (what the model must produce),
   * "output" what it returns after parsing (defaults applied). Default "input".
   */
  io?: "input" | "output";
}

/**
 * Accepts plain JSON Schema, or any schema library that implements the Standard JSON Schema interface
 * (`schema["~standard"].jsonSchema`, e.g. Zod 4), without importing the library.
 */
export function fromAny(input: unknown, options: FromAnyOptions = {}): JSONSchema {
  if (isStandardJSONSchema(input)) {
    const io = options.io ?? "input";
    return input["~standard"].jsonSchema[io]({ target: "draft-2020-12" }) as JSONSchema;
  }
  if (typeof input === "boolean") return input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    if ("~standard" in input) {
      throw new TypeError(
        "This schema library doesn't expose the Standard JSON Schema interface (~standard.jsonSchema). Convert it to JSON Schema first.",
      );
    }
    return input as JSONSchema;
  }
  throw new TypeError(`Expected a JSON Schema or a schema library object, got ${input === null ? "null" : typeof input}`);
}
