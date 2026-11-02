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
// JSON Schema fields (`parametersJsonSchema`, `responseJsonSchema`): live probes on 2026-11-02
// (gemini-3.5-flash-lite) accepted every keyword tried, including const, examples, string/number bounds, oneOf,
// allOf, not, $ref with siblings, recursion and a root anyOf, so the schema is sent as written.
// It did reject draft-07 tuple syntax ("schema at definitions.Point.items must be a boolean or an object"), so
// draft-07 spellings are rewritten to 2020-12. Accepted isn't the same as enforced: check() still validates the output.
const googleJson = (id: string): Capabilities => ({
  id,
  provider: "google",
  keywords: "any",
  draft202012: true,
  formats: "any",
  allRequired: false,
  closedObjects: false,
  rootObject: false,
  refs: true,
  refSiblings: true,
  recursion: true,
  typeArrays: true,
  openSchemas: true,
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

// Groq structured outputs, from https://console.groq.com/docs/structured-outputs, checked 2026-11-02.
// Strict mode: "All schema properties must be marked as required", "All objects must set additionalProperties: false",
// anyOf, $defs/$ref and recursion ("#" and through $defs) are documented. format, pattern and bounds aren't, so they
// are treated as unsupported until probed. Strict is documented for a few models (gpt-oss, qwen3.8, muse-spark-open).
const groqStrict = (id: string): Capabilities => ({
  id,
  provider: "groq",
  keywords: ["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "$ref", "$defs", "description"],
  formats: [],
  allRequired: true,
  closedObjects: true,
  rootObject: true,
  refs: true,
  refSiblings: false,
  recursion: true,
  typeArrays: true,
  openSchemas: false,
  limits: {},
  fields: { tool: "tools[].function.parameters", output: "response_format.json_schema.schema" },
});

// xAI (Grok) structured outputs and function calling, from https://docs.x.ai/developers/model-capabilities/text/structured-outputs
// and https://docs.x.ai/developers/tools/function-calling, checked 2026-11-02. One mode: "the strict flag is implicitly
// always true". Optional fields are allowed, objects are closed unless additionalProperties is true, $ref/$defs are
// "non-circular references only", enforced formats are listed, and pattern is an anchored ECMAScript subset without
// backreferences, \p{…}, \b, lookaround or inline modifiers. not/if/then/else and multi-branch allOf are best effort.
const xaiCaps = (id: string): Capabilities => ({
  id,
  provider: "xai",
  keywords: [
    "type", "properties", "required", "additionalProperties", "items", "prefixItems", "enum", "const", "anyOf", "$ref", "$defs",
    "format", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
    "minItems", "maxItems", "minProperties", "maxProperties", "description", "default",
  ],
  rules: {
    pattern: (v) => typeof v === "string" && !/\(\?[=!<]|\\[1-9]|\\[bB]|\\k<|\\[pP]\{|\(\?[a-zA-Z-]+[:)]/.test(v),
    enum: (v) => Array.isArray(v) && v.length > 0,
  },
  formats: ["date", "time", "date-time", "email", "uuid", "ipv4", "ipv6", "uri"],
  allRequired: false,
  closedObjects: false,
  closedByDefault: true,
  patternFullMatch: true,
  rootObject: true,
  refs: true,
  refSiblings: false,
  recursion: false,
  typeArrays: true,
  openSchemas: true,
  limits: {},
  fields: { tool: "tools[].function.parameters", output: "response_format.json_schema.schema" },
});

// DeepSeek strict tool calls (beta), from https://api-docs.deepseek.com/guides/tool_calls, checked 2026-11-02.
// Needs base_url https://api.deepseek.com/beta and strict: true on every function. "All properties of every object must
// be set as required, and additionalProperties ... must be set to false". Strings: pattern and format (email, hostname,
// ipv4, ipv6, uuid); minLength/maxLength unsupported. Numbers: const, default, bounds, multipleOf. Arrays: minItems and
// maxItems unsupported. Definitions are spelled "$def". The null type isn't listed, so nullable fields use
// anyOf with {"type": "null"} (unverified). Chat Completions has no json_schema output; the Responses API does.
const deepseekStrict = (id: string): Capabilities => ({
  id,
  provider: "deepseek",
  keywords: [
    "type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "$ref", "description",
    "pattern", "format", "const", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  ],
  rules: { const: (v) => typeof v === "number" },
  formats: ["email", "hostname", "ipv4", "ipv6", "uuid"],
  allRequired: true,
  closedObjects: true,
  rootObject: true,
  refs: true,
  refSiblings: false,
  recursion: true,
  typeArrays: false,
  openSchemas: false,
  defsKeyword: "$def",
  limits: {},
  fields: { tool: "tools[].function.parameters", output: "text.format.schema" },
});

/** Non-strict tools: any JSON Schema, but tool parameters must be an object at the root (no root anyOf/oneOf/allOf). */
const loose = (id: string, provider: "openai" | "anthropic" | "groq" | "deepseek"): Capabilities => ({
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
    provider !== "anthropic"
      ? { tool: "tools[].function.parameters", output: "response_format.json_schema.schema" }
      : { tool: "tools[].input_schema", output: "output_config.format.schema" },
});

const PLANNED = new Set(["bedrock", "mistral", "ollama"]);

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
  if (provider === "groq") return strict ? groqStrict(target) : loose(target, "groq");
  if (provider === "deepseek") return strict ? deepseekStrict(target) : loose(target, "deepseek");
  // xAI has one mode: its schema rules apply with or without `strict`.
  if (provider === "xai" || provider === "grok") return xaiCaps(target);
  // Gemini has no separate non-strict mode: its schema fields always validate, so `strict` doesn't change the rules.
  if (provider === "google" || provider === "gemini") return googleJson(target);
  if (provider === "google-openapi" || provider === "vertex") return googleOpenApi(target);
  if (PLANNED.has(provider)) {
    throw new Error(
      `Target "${target}" isn't supported yet: this release covers OpenAI, Anthropic, Gemini, Groq, xAI and DeepSeek. ` +
        `Until then, pass a capabilities object as the target.`,
    );
  }
  throw new Error(
    `Unknown provider "${provider}" in target "${target}". Use "openai", "anthropic", "google", "google-openapi", "groq", "xai", "deepseek" or pass a capabilities object.`,
  );
}
