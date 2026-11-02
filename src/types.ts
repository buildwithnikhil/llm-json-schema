/** A JSON Schema object (draft-07 or 2020-12). Boolean schemas are accepted as input too. */
export interface SchemaObject {
  [keyword: string]: unknown;
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: unknown[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  $ref?: string;
  $defs?: Record<string, JSONSchema>;
}

export type JSONSchema = SchemaObject | boolean;

/** Where the schema will be sent: a tool's parameters, or the model's final structured output. */
export type Use = "tool" | "output";

export type Provider = "openai" | "anthropic" | "google" | (string & {});

/**
 * What a target accepts. Built-in targets resolve to one of these; pass your own for models we don't know.
 * Any keyword not listed in `keywords` is removed (constraints are moved into the description and enforced by `check()`).
 */
export interface Capabilities {
  /** For error messages, e.g. "openai/gpt-4.1". */
  id: string;
  provider: Provider;
  /** Keywords the target accepts, or "any" for targets that take any JSON Schema keyword. */
  keywords: readonly string[] | "any";
  /** Value checks for accepted keywords, e.g. Anthropic accepts `minItems` only as 0 or 1. A failing value is treated as unsupported. */
  rules?: Readonly<Record<string, (value: unknown) => boolean>>;
  /** Allowed `format` values, or "any". Ignored when `format` isn't in `keywords`. */
  formats: readonly string[] | "any";
  /** Every object property must be listed in `required` (optional fields become nullable). */
  allRequired: boolean;
  /** Every object must say `additionalProperties: false`. */
  closedObjects: boolean;
  /** The root must be `type: "object"` (not a union, array or primitive). */
  rootObject: boolean;
  /** Local `$ref` / `$defs` are accepted. When false, references are inlined. */
  refs: boolean;
  /** Keywords next to a `$ref` are accepted. */
  refSiblings: boolean;
  /** Recursive schemas are accepted (requires `refs`). */
  recursion: boolean;
  /** `type: ["string", "null"]` is accepted. When false, nullable types use `anyOf` with `{type: "null"}`. */
  typeArrays: boolean;
  /**
   * Schemas without a fixed shape are accepted: `{}` (any value) and objects with no listed properties.
   * When false, such values are sent as a JSON-encoded string and `decode()` parses them.
   */
  openSchemas: boolean;
  /** OpenAPI style: nullable values say `nullable: true` (single type) instead of adding "null" to `type`. */
  nullableKeyword?: boolean;
  /** Type names are sent upper-case ("STRING", "OBJECT"), as Gemini's OpenAPI `Schema` expects. */
  upperCaseTypes?: boolean;
  /**
   * Only draft 2020-12 spellings are accepted: array `items` must be `prefixItems`, `definitions` must be `$defs`,
   * OpenAPI `nullable` must be a null type. Applies to targets that otherwise take the schema as written.
   */
  draft202012?: boolean;
  /** Limits; exceeding one throws `UnsupportedSchemaError`. */
  limits: {
    maxDepth?: number;
    maxProperties?: number;
    maxEnumValues?: number;
    /** Optional properties in one schema (Anthropic counts them across all strict tools in a request). */
    maxOptionalProperties?: number;
    /** Properties typed as a union (anyOf or a type array) in one schema (Anthropic counts them per request). */
    maxUnionProperties?: number;
  };
  /** Which request field the converted schema belongs in, per use. */
  fields: Record<Use, string>;
}

export type LossAction =
  /** Removed and restated in the description so the model still sees it; `check()` enforces it. */
  | "described"
  /** Removed. Annotations have nothing to enforce; constraints are enforced by `check()`. */
  | "dropped"
  /** Replaced by an equivalent form the target accepts. Nothing is lost. */
  | "rewritten"
  /** Replaced by a looser form; `check()` enforces the original. */
  | "relaxed"
  /** The data shape changes for the model; `decode()` turns it back into the original shape. */
  | "restructured";

export interface Loss {
  /** JSON Pointer into the original schema, e.g. "#/properties/name". */
  path: string;
  keyword: string;
  value?: unknown;
  action: LossAction;
  /** A short human-readable explanation. */
  note: string;
}

export interface ConvertOptions {
  /** "openai", "openai/gpt-4.1", ... or a capabilities object. */
  target: string | Capabilities;
  /** Default "tool". */
  use?: Use;
  /**
   * The provider's strict mode (OpenAI `strict: true`, Anthropic `strict: true` / JSON outputs). Default true.
   * With false, only the rules that apply to every request are enforced (e.g. an object at the root of tool parameters).
   */
  strict?: boolean;
  /** Throw `UnsupportedSchemaError` on any change other than "rewritten" instead of rewriting. */
  lossless?: boolean;
}

export interface CheckError {
  /** JSON Pointer into the data, e.g. "/name". */
  path: string;
  message: string;
}

export interface CheckResult {
  valid: boolean;
  errors: CheckError[];
}

export interface ConvertResult {
  /** The schema to send. */
  schema: SchemaObject;
  /** The request field it belongs in, e.g. "parameters". */
  field: string;
  /** Resolved target capabilities. */
  target: Capabilities;
  /** Every change made to the schema. Empty if it was sent unchanged. */
  losses: Loss[];
  /** Turn the model's output (parsed JSON) back into the shape of the original schema. */
  decode(output: unknown): unknown;
  /** Validate a decoded value against the original schema, including constraints the target couldn't enforce. */
  check(value: unknown): CheckResult;
}
