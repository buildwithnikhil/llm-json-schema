# llm-json-schema

Make any JSON Schema work with every LLM provider. No dependencies.

Every provider accepts a different, stricter subset of JSON Schema, and the rules differ between models from the same provider. A schema from Zod, Pydantic, TypeBox or an MCP server fails with errors like these:

- `Invalid schema for function` (OpenAI strict mode)
- `400 INVALID_ARGUMENT` and `Unknown name "examples"` (Gemini)
- a rejected `input_schema` (Anthropic)

`llm-json-schema` rewrites the schema into the form the target model accepts, reports exactly what it changed, and converts the model's output back into your original shape.

> **Status: 0.1.** OpenAI and Anthropic are supported, in both strict and non-strict modes. Gemini is next.

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

Provider strict mode is the default. For tools sent with `strict: false`, pass `strict: false` here too. The schema is then sent exactly as written, except where the provider rejects it outright: tool parameters must be an object at the root, so a root `anyOf` is wrapped and a root `allOf` is merged.

### From Zod, or any Standard JSON Schema library

```ts
import { convert, fromAny } from "llm-json-schema";

const r = convert(fromAny(zodSchema), { target: "openai" });
const data = zodSchema.parse(r.decode(output)); // optional fields come back absent, so defaults apply
```

`fromAny()` reads `schema["~standard"].jsonSchema`, which Zod 4 implements, so llm-json-schema never imports your schema library. Plain JSON Schema (draft-07 or 2020-12) is passed through.

## What it changes

`losses` lists every change. Each one has one of these `action` values:

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
| Any provider with `strict: false` | Any JSON Schema, with an object at the root of tool parameters. |
| A capabilities object | Your own rules, for self-hosted or unlisted models. Start from `resolveTarget("openai")` and adjust. |

**How the rules were verified.** In 0.1, the rules come from each provider's documentation (checked 2026-11-02). Where the docs say nothing about a keyword, it's treated as unsupported and rewritten, so the output stays on the safe side. The worst case is a change that wasn't needed, not a rejected request. The test suite checks every converted schema against those documented rules. Live API probes (`npm run probe`) will publish a compatibility table; until then, a converted schema that a provider rejects is a bug: please [open an issue](https://github.com/buildwithnikhil/llm-json-schema/issues) with the schema and the error, and corrections ship as patch releases.

## Stability

The output is guaranteed to be accepted by the target and to decode back to your original shape. The exact output schema is not guaranteed to stay the same between releases.
- **Patch release:** the rules got stricter, fixing a rejection.
- **Minor release:** the rules got looser, so fewer changes are made.
- **Major release:** the API changed.

ESM and CJS with types. Node 18 or later. MIT license.
