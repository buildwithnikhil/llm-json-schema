import type { Capabilities } from "./types.js";

// Rules come from provider docs (dates below); keywords the docs don't list are treated as unsupported until
// `npm run probe` shows otherwise.

// OpenAI Structured Outputs / strict function calling:
// https://developers.openai.com/api/docs/guides/structured-outputs ("Supported schemas"), checked 2026-11-02.
const OPENAI_KEYWORDS = [
  "type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "$ref", "$defs", "description",
  "pattern", "format",
  "multipleOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems",
] as const;
// "Not supported for fine-tuned models": string length/pattern/format, number bounds, array sizes.
const OPENAI_FINE_TUNED_UNSUPPORTED = new Set([
  "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
]);

const openaiStrict = (id: string, fineTuned: boolean): Capabilities => ({
  id,
  provider: "openai",
  keywords: fineTuned ? OPENAI_KEYWORDS.filter((k) => !OPENAI_FINE_TUNED_UNSUPPORTED.has(k)) : OPENAI_KEYWORDS,
  formats: ["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"],
  allRequired: true,
  closedObjects: true,
  rootObject: true,
  refs: true,
  refSiblings: false,
  recursion: true,
  typeArrays: true,
  openSchemas: false,
  limits: { maxDepth: 10, maxProperties: 5000, maxEnumValues: 1000 },
  fields: { tool: "tools[].function.parameters", output: "response_format.json_schema.schema" },
});

// Anthropic strict tool use and JSON outputs share one subset:
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs ("JSON Schema limitations"), checked 2026-11-02.
const primitive = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
// "NOT supported: backreferences, lookahead/lookbehind, word boundaries".
const simplePattern = (v: unknown) => typeof v === "string" && !/\(\?[=!<]|\\[1-9]|\\[bB]|\\k</.test(v);

const anthropicStrict = (id: string): Capabilities => ({
  id,
  provider: "anthropic",
  keywords: [
    "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "$ref", "$defs",
    "description", "default", "format", "minItems", "pattern",
  ],
  rules: {
    minItems: (v) => v === 0 || v === 1,
    pattern: simplePattern,
    enum: (v) => Array.isArray(v) && v.every(primitive),
    const: primitive,
  },
  formats: ["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"],
  allRequired: false,
  closedObjects: true,
  rootObject: true,
  refs: true,
  refSiblings: false,
  recursion: false,
  typeArrays: true,
  openSchemas: false,
  limits: { maxOptionalProperties: 24, maxUnionProperties: 16 },
  fields: { tool: "tools[].input_schema", output: "output_config.format.schema" },
});

// Gemini API, from https://ai.google.dev/api/generate-content (Schema, FunctionDeclaration, GenerationConfig),
// checked 2026-11-02.
//
// JSON Schema fields (`parametersJsonSchema`, `responseJsonSchema`): the documented keyword list, with oneOf
// "interpreted the same as anyOf" (rewritten here), "$ref ... no other properties" and cyclic references only in
// non-required properties (treated as unsupported until probed).
const googleJson = (id: string): Capabilities => ({
  id,
  provider: "google",
  keywords: [
    "type", "format", "title", "description", "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum",
    "anyOf", "properties", "additionalProperties", "required", "$ref", "$defs",
  ],
  formats: ["date-time", "date", "time"],
  allRequired: false,
  closedObjects: false,
  rootObject: true,
  refs: true,
  refSiblings: false,
  recursion: false,
  typeArrays: true,
  openSchemas: false,
  limits: {},
  fields: { tool: "tools[].functionDeclarations[].parametersJsonSchema", output: "generationConfig.responseJsonSchema" },
});

// OpenAPI `Schema` fields (`parameters`, `responseSchema`), which Vertex AI SDKs and older clients build: only the
// listed fields exist (anything else fails with `Unknown name`), enum is for STRING only, types are upper-case.
const googleOpenApi = (id: string): Capabilities => ({
  id,
  provider: "google",
  keywords: [
    "type", "format", "title", "description", "enum", "items", "minItems", "maxItems", "properties", "required",
    "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "anyOf", "default", "minimum", "maximum",
  ],
  rules: { enum: (v) => Array.isArray(v) && v.every((x) => typeof x === "string") },
  formats: "any",
  allRequired: false,
  closedObjects: false,
  rootObject: true,
  refs: false,
  refSiblings: false,
  recursion: false,
  typeArrays: false,
  openSchemas: false,
  nullableKeyword: true,
  upperCaseTypes: true,
  limits: {},
  fields: { tool: "tools[].functionDeclarations[].parameters", output: "generationConfig.responseSchema" },
});

/** Non-strict tools: any JSON Schema, but tool parameters must be an object at the root (no root anyOf/oneOf/allOf). */
const loose = (id: string, provider: "openai" | "anthropic"): Capabilities => ({
  id,
  provider,
  keywords: "any",
  formats: "any",
  allRequired: false,
  closedObjects: false,
  rootObject: true,
  refs: true,
  refSiblings: true,
  recursion: true,
  typeArrays: true,
  openSchemas: true,
  limits: {},
  fields:
    provider === "openai"
      ? { tool: "tools[].function.parameters", output: "response_format.json_schema.schema" }
      : { tool: "tools[].input_schema", output: "output_config.format.schema" },
});

const PLANNED = new Set(["bedrock", "mistral", "groq", "xai", "deepseek", "ollama"]);

/** Resolve "provider" or "provider/model" to the capabilities that apply. */
export function resolveTarget(target: string | Capabilities, options: { strict?: boolean } = {}): Capabilities {
  if (typeof target === "object" && target !== null) return target;
  if (typeof target !== "string" || target.trim() === "") {
    throw new TypeError(`target must be a "provider/model" string or a capabilities object`);
  }
  const strict = options.strict ?? true;
  const slash = target.indexOf("/");
  const provider = (slash === -1 ? target : target.slice(0, slash)).toLowerCase();
  const model = slash === -1 ? "" : target.slice(slash + 1);
  if (provider === "openai") return strict ? openaiStrict(target, model.startsWith("ft:")) : loose(target, "openai");
  if (provider === "anthropic" || provider === "claude") {
    if (!strict) return loose(target, "anthropic");
    if (/^claude-(2|3|instant)/.test(model)) {
      throw new Error(`${target} doesn't support strict tool use or JSON outputs. Use { strict: false }.`);
    }
    return anthropicStrict(target);
  }
  // Gemini has no separate non-strict mode: its schema fields always validate, so `strict` doesn't change the rules.
  if (provider === "google" || provider === "gemini") return googleJson(target);
  if (provider === "google-openapi" || provider === "vertex") return googleOpenApi(target);
  if (PLANNED.has(provider)) {
    throw new Error(
      `Target "${target}" isn't supported yet: this release covers OpenAI, Anthropic and Gemini. ` +
        `Until then, pass a capabilities object as the target.`,
    );
  }
  throw new Error(
    `Unknown provider "${provider}" in target "${target}". Use "openai", "anthropic", "google", "google-openapi" or pass a capabilities object.`,
  );
}
