# Providers

For each target: where the converted schema goes, what changes, and where the rules come from. Every rule source was checked on 2026-11-02. "Live" means the rules were tested against the real API; "docs" means they come from the provider's documentation (see [compatibility](compatibility.md)).

| Provider | Target strings | Strict / non-strict | Rules from |
|---|---|---|---|
| [OpenAI](#openai) | `openai`, `openai/<model>`, `openai/ft:<model>` | both | docs |
| [Anthropic](#anthropic) | `anthropic`, `anthropic/<model>`, `claude/<model>` | both | docs |
| [Gemini](#gemini) | `google`, `gemini/<model>`; `google-openapi`, `vertex` | one mode per dialect | **live** |
| [Groq](#groq) | `groq`, `groq/<model>` | both | docs |
| [xAI](#xai) | `xai`, `xai/<model>`, `grok` | one mode | docs |
| [DeepSeek](#deepseek) | `deepseek`, `deepseek/<model>` | both | docs |
| [Mistral](#mistral) | `mistral`, `mistral/<model>` | one mode | docs (no rules published) |
| [Ollama](#ollama) | `ollama`, `ollama/<model>` | per `use` | docs and source |
| [Amazon Bedrock](#amazon-bedrock) | `bedrock`, `bedrock/<model id>` | both | docs |

## OpenAI

```ts
const r = convert(schema, { target: "openai" });
tools: [{ type: "function", function: { name, parameters: r.schema, strict: true } }]
// use: "output" → response_format: { type: "json_schema", json_schema: { name, schema: r.schema, strict: true } }
```

**Strict:**
- **Required fields:** every property is required, and optional ones become nullable (`decode()` removes the nulls).
- **Objects:** closed, and the root is an object.
- **Allowed:** `$defs`/`$ref` and recursion.
- **Rewritten:**
  - `allOf` is merged and `oneOf` becomes `anyOf`.
  - `not`/`if` are dropped; `check()` enforces them.
  - Maps become `[{key, value}]` and tuples become `{"0": …}`.
- **Limits:** depth 10, 5,000 properties, 1,000 enum values.
- **Fine-tuned models** (`openai/ft:…`) also lose `pattern`, `format`, number bounds and array sizes.

[Source](https://developers.openai.com/api/docs/guides/structured-outputs)

## Anthropic

```ts
const r = convert(schema, { target: "anthropic" });
tools: [{ name, description, input_schema: r.schema, strict: true }]
// use: "output" → output_config: { format: { type: "json_schema", schema: r.schema } }
```

**Strict:**
- **Required fields:** optional fields stay optional.
- **Objects:** closed.
- **Kept:** `const`, `default` and `format: uri`.
- **Moved to the description:** number and length bounds, `minItems` above 1, and lookaround/backreference patterns.
- **No recursion.**
- **Limits:** at most 24 optional and 16 union-typed properties.
- **Models:** Claude 3 models need `strict: false`.

**Non-strict:** sent as written. The exception is a root `anyOf`/`oneOf`/`allOf`, which Anthropic rejects even without strict mode. A union of objects is merged into one object with the same argument shape, and anything else is wrapped.

[Source](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

## Gemini

Two dialects, in two different request fields:

```ts
// @google/genai: JSON Schema fields
const r = convert(schema, { target: "google" });
tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema: r.schema }] }]
// use: "output" → config.responseJsonSchema

// Vertex AI SDKs / older clients: the OpenAPI Schema
const v = convert(schema, { target: "google-openapi" });
tools: [{ functionDeclarations: [{ name, description, parameters: v.schema }] }]
// use: "output" → generationConfig.responseSchema
```

- **`google`:** a live probe accepted every keyword tried, so the schema is sent as written. The one exception is draft-07 spellings: Gemini rejected array-form `items`, so draft-07 is rewritten to 2020-12. Most "Unknown name" errors happen because the schema went into `parameters` instead of `parametersJsonSchema`, so use `r.field`.
- **`google-openapi`:** only the OpenAPI `Schema` fields are kept, so `additionalProperties`, `$ref`, `const`, `examples` and vendor keywords are removed or rewritten. Types are upper-case, nullable fields use `nullable: true`, and enums are strings only. Every converted test schema was accepted live.

[Source](https://ai.google.dev/api/generate-content) · [live results](compatibility.md)

## Groq

```ts
const r = convert(schema, { target: "groq/openai/gpt-oss-120b" });
response_format: { type: "json_schema", json_schema: { name, schema: r.schema, strict: true } }
```

- **Strict:**
  - **Required fields:** every property is required.
  - **Allowed:** closed objects, `anyOf`, `$defs`/`$ref` and recursion.
  - **Moved to the description:** `format`, `pattern` and bounds. Groq doesn't document them.
- **Models:** Groq documents strict mode for gpt-oss, qwen3.8 and muse-spark-open. Use `strict: false` for other models.

[Source](https://console.groq.com/docs/structured-outputs)

## xAI

```ts
const r = convert(schema, { target: "xai/grok-4.7" });
tools: [{ type: "function", function: { name, parameters: r.schema } }]
```

- **One mode** (the `strict` flag is always on at xAI).
- **Kept:** optional fields, bounds, `const` and enforced formats.
- **No recursion.**
- **Patterns** match the whole string on xAI, so unanchored ones are widened. Lookaround, `\b`, `\p{…}`, backreferences and inline flags move to the description.
- **Objects** are closed by default, so free-form objects get `additionalProperties: true`.

[Source](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)

## DeepSeek

```ts
const r = convert(schema, { target: "deepseek/deepseek-v4-pro" });
// base_url: "https://api.deepseek.com/beta", and strict: true on every function
tools: [{ type: "function", function: { name, parameters: r.schema, strict: true } }]
```

- **Strict (beta):**
  - **Required fields:** every property is required, and nullable fields use `anyOf` with `{type: "null"}`.
  - **Objects:** closed.
  - **Recursion:** uses **`$def`**, DeepSeek's spelling.
  - **Moved to the description:** string and array bounds.
- **Structured output:** Chat Completions only has `json_object`, so `use: "output"` targets the Responses API's `text.format.schema`.

[Source](https://api-docs.deepseek.com/guides/tool_calls)

## Mistral

Mistral's docs name the fields but publish no schema rules, so the schema is sent as written, with an object root for tools.

```ts
const r = convert(schema, { target: "mistral/mistral-large-latest" });
tools: [{ type: "function", function: { name, parameters: r.schema } }]
// use: "output" → response_format: { type: "json_schema", json_schema: { name, schema: r.schema } }
```

[Source](https://docs.mistral.ai/studio/conversations/structured-output/custom.md)

## Ollama

```ts
const tool = convert(schema, { target: "ollama" });                  // tools[].function.parameters
const out = convert(schema, { target: "ollama", use: "output" });    // the "format" field of /api/chat
```

- **Tools:** Ollama keeps only `type`, `properties`, `required`, `items`, `anyOf`, `enum` and `description`, and silently drops everything else. Here, the other keywords are moved to the description so the model still sees them.
- **Output (`format`):** enforced by llama.cpp's grammar converter:
  - patterns are anchored
  - number bounds and `prefixItems` are avoided
  - `$ref`s are inlined
  - free-form objects get `additionalProperties: true`

[Source](https://docs.ollama.com/capabilities/structured-outputs.md) · `github.com/ollama/ollama` and llama.cpp `grammars/README.md`

## Amazon Bedrock

```ts
const r = convert(schema, { target: "bedrock/us.anthropic.claude-sonnet-5-5" });
toolConfig: { tools: [{ toolSpec: { name, inputSchema: { json: r.schema }, strict: true } }] }
// use: "output" → outputConfig: { textFormat: { type: "json_schema", structure: { jsonSchema: { schema: JSON.stringify(r.schema) } } } }
```

- **Output schemas are JSON strings:** for `use: "output"`, send `JSON.stringify(r.schema)`.
- **Strict:**
  - **Required fields:** optional fields are allowed.
  - **Objects:** closed.
  - **Kept:** `const`, `default` and listed formats.
  - **`minItems`:** 0 or 1 only.
  - **Not allowed:** recursion, number bounds and length bounds.
  - **Limits:** at most 12 optional and 16 union-typed properties.
- **Models:** Nova and Llama don't support structured outputs or strict tools, so use `strict: false`.

[Source](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.md)

## Anything else

Pass a [capabilities object](api.md#capabilities). Start from the closest built-in target:

```ts
const vllm = { ...resolveTarget("openai"), id: "vllm/qwen", recursion: false, limits: {} };
const r = convert(schema, { target: vllm });
```
