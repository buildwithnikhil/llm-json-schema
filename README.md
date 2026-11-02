# llm-json-schema

Make any JSON Schema work with every LLM provider. No dependencies.

Every provider accepts a different, stricter subset of JSON Schema, and the rules differ between models from the same provider. A schema from Zod, Pydantic, TypeBox or an MCP server fails with errors like these:

- `Invalid schema for function` (OpenAI strict mode)
- `400 INVALID_ARGUMENT` and `Unknown name "additionalProperties"` (Gemini)
- a rejected `input_schema` (Anthropic)

`llm-json-schema` rewrites the schema into the form the target model accepts, reports exactly what it changed, and converts the model's output back into your original shape.

> **Status: 0.7.** OpenAI, Anthropic, Gemini (both schema dialects), Groq, xAI, DeepSeek, Mistral and Ollama are supported.

```sh
npm install llm-json-schema
```

## Usage

```ts
import { convert } from "llm-json-schema";

const r = convert(schema, { target: "openai/gpt-4.1", use: "tool" });

// Send r.schema in r.field ("tools[].function.parameters") with strict: true.
const value = r.decode(JSON.parse(toolCall.function.arguments)); // back in your original shape
const { valid, errors } = r.check(value); // includes the constraints OpenAI couldn't enforce

r.losses;
// [{ path: "#/properties/name", keyword: "minLength", value: 3, action: "described",
//    note: "minLength isn't enforced by openai/gpt-4.1; stated in the description and enforced by check()" }]
```

To use the schema as the model's final output instead, pass `use: "output"`. `r.field` then names the right place, for example `response_format.json_schema.schema` for OpenAI or `output_config.format.schema` for Anthropic.

Provider strict mode is the default. For OpenAI or Anthropic tools sent with `strict: false`, pass `strict: false` here too. The schema is then sent as written, except where the provider rejects it outright: tool parameters must be an object at the root.
- A root `anyOf`/`oneOf` whose variants are all objects is merged into one object, so the model's arguments keep their shape and need no decoding. That suits proxies that stream tool arguments.
- A root `allOf` of objects is merged.
- Any other root is wrapped as `{"value": …}`, and `decode()` unwraps it.

### From Zod, or any Standard JSON Schema library

```ts
import { convert, fromAny } from "llm-json-schema";

const r = convert(fromAny(zodSchema), { target: "openai" });
const data = zodSchema.parse(r.decode(output)); // optional fields come back absent, so defaults apply
```

`fromAny()` reads `schema["~standard"].jsonSchema`, which Zod 4 implements, so llm-json-schema never imports your schema library. Plain JSON Schema (draft-07 or 2020-12) is passed through.

## What it changes

`losses` lists every change. The only exception is spelling-only rewrites from draft-07 to 2020-12 (`definitions` → `$defs`, array `items` → `prefixItems`), which are listed only for targets that send the schema as written. Each entry has one of these `action` values:

| Action | Meaning | Example (OpenAI) |
|---|---|---|
| `rewritten` | Replaced by an equivalent form. Nothing is lost. | `const` → one-value `enum`. `allOf` merged into one schema. A `$ref` with sibling keywords inlined. |
| `described` | Removed, but stated in the description so the model still sees it. `check()` enforces it. | `minLength`, `default`, `examples`, `format: "uri"` |
| `relaxed` | Replaced by a looser form. `check()` enforces the original. | `oneOf` → `anyOf` |
| `restructured` | The data shape changes for the model. `decode()` reverses it. | Optional field → required and nullable, with the null removed again. A map → `[{key, value}]`. A tuple → `{"0": …, "1": …}`. An untyped value → a JSON string. A non-object root → `{"value": …}`. |
| `dropped` | Removed. It was an annotation, or `check()` enforces it. | `title`, `x-*` and vendor keywords such as `human_parameter_name`; `not`, `if`/`then`/`else` |

If no faithful version of the schema exists for the target, `convert()` throws `UnsupportedSchemaError` with the path and a suggested fix. Examples are an `allOf` whose parts contradict each other, an external `$ref`, a recursive schema for a target without recursion (Anthropic strict), and a schema over the target's limits. Pass `lossless: true` to throw on any change other than `rewritten`.

## Targets

| Target | Rules |
|---|---|
| `"openai"`, `"openai/<model>"` | OpenAI's strict subset: every property required, `additionalProperties: false`, an object at the root, `$defs`/`$ref` and recursion allowed, no `allOf`/`not`/conditionals, at most 10 levels deep, 5,000 properties and 1,000 enum values. |
| `"openai/ft:<model>"` | The same, without `pattern`, `format`, number bounds or `minItems`/`maxItems`, which fine-tuned models don't support. |
| `"anthropic"`, `"anthropic/<model>"` | Anthropic's strict tool and JSON-output subset: closed objects, but optional fields are allowed. `const`, `default` and `uri` are kept. No recursion, number or length bounds, `minItems` above 1, or lookaround/backreference patterns. At most 24 optional and 16 union-typed properties. Claude 3 models need `strict: false`. |
| `"google"`, `"gemini/<model>"` | Gemini's JSON Schema fields (`parametersJsonSchema`, `responseJsonSchema`), the ones `@google/genai` uses. Live probes accepted every keyword tried, so the schema is sent as written. The exception is draft-07 spellings: Gemini rejected array-form `items`, so draft-07 is rewritten to 2020-12. Use `r.field` to put the schema in the JSON Schema field rather than `parameters`, which is where most Gemini schema errors come from. |
| `"google-openapi"`, `"vertex"` | Gemini's OpenAPI `Schema` fields (`parameters`, `responseSchema`), which Vertex AI SDKs and older clients build. Only its listed fields are kept (no `additionalProperties`, `$ref`, `const` or `examples`), enums are strings only, nullable fields use `nullable: true`, and type names are upper-case. |
| `"groq"`, `"groq/<model>"` | Groq's strict structured outputs: every property required, closed objects, `anyOf`, `$defs`/`$ref` and recursion. Groq doesn't document `format`, `pattern` or bounds, so they're moved to the description. Groq documents strict mode for some models only (gpt-oss, qwen3.8, muse-spark-open). For other models, use `strict: false`. |
| `"xai"`, `"xai/<model>"`, `"grok"` | xAI's schema rules, which always apply (`strict` changes nothing): optional fields allowed, bounds/`const`/`uri` kept, no recursion. Patterns match the whole string on xAI, so unanchored ones are widened (`@` → `^.*(?:@).*$`), and lookaround, `\b`, `\p{…}`, backreferences and inline flags move to the description. Objects are closed by default, so free-form objects get `additionalProperties: true`. `not`/`if`/`then`/`else` are dropped (xAI treats them as best effort); `check()` enforces them. |
| `"deepseek"`, `"deepseek/<model>"` | DeepSeek's strict tool calls (beta: use `base_url` `https://api.deepseek.com/beta` and `strict: true` on every function). Every property required, closed objects, recursion via `$def` (DeepSeek's spelling). String and array length bounds move to the description; number bounds, `pattern` and listed formats stay. For `use: "output"`, the schema goes in the Responses API's `text.format.schema`; Chat Completions has no JSON Schema output. |
| `"mistral"`, `"mistral/<model>"` | Mistral's docs name the fields (`tools[].function.parameters`, `response_format.json_schema`) but list no schema rules, so the schema is sent as written, with an object root for tools. |
| `"ollama"`, `"ollama/<model>"` | Two rule sets, picked by `use`. **Tools:** Ollama keeps only `type`, `properties`, `required`, `items`, `anyOf`, `enum` and `description` and silently drops everything else, so other keywords are moved to the description where the model can still see them. **`use: "output"`** (the `format` field): llama.cpp's grammar converter, so patterns are anchored (`^…$`), number bounds and `prefixItems` are avoided, `$ref`s are inlined, and free-form objects get `additionalProperties: true`. |
| `"openai"`, `"anthropic"`, `"groq"` or `"deepseek"` with `strict: false` | Any JSON Schema, with an object at the root of tool parameters. |
| A capabilities object | Your own rules, for self-hosted or unlisted models. Start from `resolveTarget("openai")` and adjust. |

**How the rules were verified.** Gemini's rules were checked against the live API on 2026-11-02 (`gemini-3.5-flash-lite`). OpenAI's and Anthropic's come from their documentation (checked 2026-11-02). Where the docs say nothing about a keyword, it's treated as unsupported and rewritten, so the output stays on the safe side. The worst case is a change that wasn't needed, not a rejected request. The test suite checks every converted schema against those documented rules. See the **[compatibility table](docs/compatibility.md)** for what was tested and how each keyword is handled per target. A converted schema that a provider rejects is a bug: please [open an issue](https://github.com/buildwithnikhil/llm-json-schema/issues) with the schema and the error, and corrections ship as patch releases.

## Stability

The output is meant to be accepted by the target and to decode back to your original shape. A rejection is a bug, so please report it. The exact output schema is not guaranteed to stay the same between releases.
- **Patch release:** the rules got stricter, fixing a rejection.
- **Minor release:** the rules got looser, so fewer changes are made.
- **Major release:** the API changed.

ESM and CJS with types. Node 18 or later. MIT license.
