# API reference

```ts
import { convert, fromAny, resolveTarget, UnsupportedSchemaError } from "llm-json-schema";
```

ESM and CommonJS (`require("llm-json-schema")`) both work, with TypeScript types included. Node 18 or later.

- [`convert(schema, options)`](#convertschema-options)
- [`fromAny(input, options?)`](#fromanyinput-options)
- [`resolveTarget(target, options?)`](#resolvetargettarget-options)
- [`UnsupportedSchemaError`](#unsupportedschemaerror)
- [Capabilities](#capabilities)

## `convert(schema, options)`

Rewrites a JSON Schema into the form a target accepts.

```ts
const r = convert(schema, { target: "openai/gpt-4.1", use: "tool" });
```

`schema` is a JSON Schema: draft-07 or 2020-12, local `$ref`s allowed, booleans allowed. Use [`fromAny()`](#fromanyinput-options) to pass a Zod 4 schema. The input is never modified.

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `target` | `string \| Capabilities` | required | `"provider"` or `"provider/model"`, for example `"openai"`, `"anthropic/claude-sonnet-5-5"` or `"bedrock/us.anthropic.claude-sonnet-5-5"`. You can also pass your own [capabilities](#capabilities). See [providers](providers.md). |
| `use` | `"tool" \| "output"` | `"tool"` | Where the schema goes: a tool's parameters, or the model's structured output. Some providers have different rules for each. |
| `strict` | `boolean` | `true` | The provider's strict mode (for example OpenAI `strict: true`). With `false`, only the rules that apply to every request are enforced. Gemini, xAI, Mistral and Ollama have a single mode, so for them `strict` changes nothing. |
| `lossless` | `boolean` | `false` | Throw `UnsupportedSchemaError` on any change other than `rewritten`, instead of rewriting. |

### Result

| Field | Type | Meaning |
|---|---|---|
| `schema` | object | The schema to send. |
| `field` | string | The request field it belongs in, for example `"tools[].function.parameters"`. |
| `target` | `Capabilities` | The rules that were applied. |
| `losses` | `Loss[]` | Every change made, in order. Empty if the schema was sent unchanged. |
| `decode(output)` | function | Turns the model's parsed output back into the shape of your original schema. |
| `check(value)` | function | Validates a decoded value against your original schema, including constraints the target couldn't enforce. Returns `{ valid, errors: [{ path, message }] }`. |

### `Loss`

```ts
{ path: "#/properties/name", keyword: "minLength", value: 3, action: "described", note: "minLength isn't enforced by openai; ..." }
```

- `path` is a JSON Pointer into your **original** schema.
- `action` is one of these:

| Action | Meaning | What covers it |
|---|---|---|
| `rewritten` | Replaced by an equivalent form; nothing lost | — |
| `described` | Removed, but restated in the `description` so the model still sees it | `check()` |
| `relaxed` | Replaced by a looser form | `check()` |
| `restructured` | The data shape changes for the model | `decode()` |
| `dropped` | Removed: an annotation, or a constraint | `check()`, for constraints |

### Typical flow

```ts
const r = convert(schema, { target: "openai" });
const res = await openai.chat.completions.create({
  model: "gpt-4.1",
  messages,
  tools: [{ type: "function", function: { name: "search", parameters: r.schema, strict: true } }],
});
const call = res.choices[0].message.tool_calls[0];
const args = r.decode(JSON.parse(call.function.arguments)); // your original shape
const { valid, errors } = r.check(args);                     // the constraints OpenAI couldn't enforce
if (!valid) throw new Error(errors.map((e) => `${e.path} ${e.message}`).join("; "));
```

`check()` takes the **decoded** value. It validates against your original schema, using the same rules as any JSON Schema validator for the keywords it covers. It doesn't enforce `unevaluatedProperties`, `unevaluatedItems` or `$dynamicRef`.

## `fromAny(input, options?)`

Returns plain JSON Schema from either:
- a JSON Schema object (returned as is), or
- a schema library object that implements the Standard JSON Schema interface (`input["~standard"].jsonSchema`), such as **Zod 4**. The library is never imported.

```ts
import { z } from "zod";
const User = z.object({ name: z.string().min(1), age: z.number().int().optional() });
const r = convert(fromAny(User), { target: "anthropic" });
const user = User.parse(r.decode(output));
```

| Option | Default | Meaning |
|---|---|---|
| `io` | `"input"` | `"input"`: what the schema accepts, which is what the model must produce. `"output"`: what it returns after parsing, with defaults applied. |

It throws a `TypeError` for schema-library objects without the interface. For Zod 3, Valibot or TypeBox, convert to JSON Schema with that library's own tool first.

## `resolveTarget(target, options?)`

Returns the [capabilities](#capabilities) for a target string, which is the same lookup `convert()` does. Use it to inspect the rules, or as a starting point for your own:

```ts
const mine = { ...resolveTarget("openai"), id: "my-vllm", recursion: false };
convert(schema, { target: mine });
```

Options: `{ strict?: boolean, use?: "tool" | "output" }`. Some providers, like Ollama, have different rules per use.

It throws for unknown providers, and for models that don't support the requested mode. For example, `"anthropic/claude-3-5-sonnet-…"` and Bedrock Nova or Llama with `strict: true` throw.

## `UnsupportedSchemaError`

Thrown by `convert()` when no faithful version of the schema exists for the target:

```ts
try {
  convert(schema, { target: "anthropic" });
} catch (e) {
  if (e instanceof UnsupportedSchemaError) console.log(e.path, e.reason, e.suggestion);
}
```

| Field | Meaning |
|---|---|
| `path` | JSON Pointer into the original schema |
| `target` | The target id |
| `reason` | What isn't supported, for example "recursive schemas aren't accepted" |
| `suggestion` | How to fix the schema, when there's a known fix |

Common causes:
- an `allOf` whose parts contradict each other
- an external `$ref` (bundle it into `$defs` first)
- recursion on a target without it (Anthropic, Bedrock, xAI, Ollama, Gemini OpenAPI)
- schemas over a target's limits: depth, property count, enum values, optional or union properties
- with `lossless: true`, any change other than `rewritten`

## Capabilities

A target's rules. Built-in targets resolve to one of these; pass your own for anything else.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Name used in messages. |
| `provider` | string | Provider name. |
| `keywords` | `string[] \| "any"` | Keywords the target accepts. Others are moved to the description (constraints) or dropped (annotations). `"any"` sends the schema as written, apart from the root rule. |
| `rules` | `{ [keyword]: (value) => boolean }` | Value checks for accepted keywords, for example `minItems` only 0 or 1. A failing value is treated as unsupported. |
| `formats` | `string[] \| "any"` | Accepted `format` values. |
| `allRequired` | boolean | Every property must be in `required`. Optional ones become nullable, and `decode()` removes the nulls. |
| `closedObjects` | boolean | Every object must say `additionalProperties: false`. |
| `closedByDefault` | boolean | Objects without `additionalProperties` are closed. Free-form objects get `additionalProperties: true`. |
| `rootObject` | boolean | The root must be an object. Other roots are merged or wrapped as `{"value": …}`. |
| `refs` | boolean | Local `$ref`/`$defs` are accepted. When false, references are inlined. |
| `refSiblings` | boolean | Keywords next to a `$ref` are accepted. |
| `recursion` | boolean | Recursive schemas are accepted. |
| `typeArrays` | boolean | `type: ["string", "null"]` is accepted. When false, `anyOf` is used instead. |
| `openSchemas` | boolean | `{}` and objects with no listed properties are accepted. When false, they're sent as JSON-encoded strings. |
| `nullableKeyword` | boolean | Nullable values use OpenAPI `nullable: true`. |
| `upperCaseTypes` | boolean | Type names are upper-case (`"STRING"`). |
| `patternFullMatch` | boolean | Patterns match the whole string. Unanchored ones are widened (`@` → `^.*(?:@).*$`). |
| `draft202012` | boolean | Only 2020-12 spellings are accepted (`prefixItems`, `$defs`). |
| `defsKeyword` | string | The name the target uses for `$defs`, for example DeepSeek's `"$def"`. |
| `limits` | object | `maxDepth`, `maxProperties`, `maxEnumValues`, `maxOptionalProperties`, `maxUnionProperties`. Going over one throws. |
| `fields` | `{ tool, output }` | Where the schema goes in a request. |
