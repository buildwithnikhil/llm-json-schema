# Guides

- [Zod schemas](#zod-schemas)
- [MCP tools](#mcp-tools)
- [One schema, several providers](#one-schema-several-providers)
- [Proxies and streamed tool arguments](#proxies-and-streamed-tool-arguments)
- [Handling errors](#handling-errors)
- [Reviewing what changed](#reviewing-what-changed)

## Zod schemas

```ts
import { z } from "zod";
import { convert, fromAny } from "llm-json-schema";

const Search = z.object({
  query: z.string().min(1),
  limit: z.number().int().max(50).optional(),
  sort: z.enum(["relevance", "date"]).default("relevance"),
});

const r = convert(fromAny(Search), { target: "openai" });
// …send r.schema as the tool's parameters with strict: true…
const args = Search.parse(r.decode(JSON.parse(toolCall.function.arguments)));
```

OpenAI strict mode makes every field required, so `limit` and `sort` become nullable. `decode()` removes the nulls again, so Zod sees the fields as absent and applies `sort`'s default. `min(1)` and `max(50)` are moved into the descriptions, and `Search.parse` enforces them.

## MCP tools

MCP servers send tool schemas as JSON Schema, often with `$ref`, root `oneOf`, `examples`, or vendor keywords that providers reject. Convert each one before handing it to the model:

```ts
const { tools } = await mcpClient.listTools();
const converted = tools.map((t) => ({ tool: t, r: convert(t.inputSchema, { target: "anthropic", strict: false }) }));

const anthropicTools = converted.map(({ tool, r }) => ({ name: tool.name, description: tool.description, input_schema: r.schema }));

// When the model calls a tool:
const { r } = converted.find(({ tool }) => tool.name === block.name);
await mcpClient.callTool({ name: block.name, arguments: r.decode(block.input) });
```

## One schema, several providers

Convert once per provider, and keep each result next to the request that used it. You'll need it for `decode()`.

```ts
const targets = ["openai", "anthropic", "google"];
const bySchema = Object.fromEntries(targets.map((t) => [t, convert(schema, { target: t })]));

for (const [t, r] of Object.entries(bySchema)) console.log(t, r.field, r.losses.length, "changes");
```

## Proxies and streamed tool arguments

A gateway that forwards tool arguments as they stream can't run `decode()` on partial JSON. For those, only use results whose argument shape didn't change:

```ts
function toProvider(schema, target) {
  try {
    const r = convert(schema, { target, strict: false });
    if (r.losses.some((l) => l.action === "restructured")) return schema; // the shape would change: keep the old behavior
    return r.schema;
  } catch {
    return schema; // never fail a request because of the converter
  }
}
```

In non-strict mode, a root union of objects is merged into one object without changing the shape, so this covers the common "root `anyOf` rejected" case.

## Handling errors

```ts
import { convert, UnsupportedSchemaError } from "llm-json-schema";

try {
  const r = convert(schema, { target: "anthropic" });
} catch (e) {
  if (!(e instanceof UnsupportedSchemaError)) throw e;
  // e.path: where in your schema; e.reason: what's unsupported; e.suggestion: how to fix it
  console.error(`${e.target}: ${e.reason} at ${e.path}. ${e.suggestion ?? ""}`);
}
```

To refuse any change that loses information, pass `lossless: true`. Equivalent rewrites, such as `const` to a one-value `enum`, are still allowed.

## Reviewing what changed

`losses` is meant to be read. A quick way to spot schemas that changed a lot:

```ts
const r = convert(schema, { target: "openai" });
for (const l of r.losses) console.log(`${l.action.padEnd(12)} ${l.path} ${l.keyword}: ${l.note}`);
```

A good habit is to snapshot `r.losses` in your tests. A new `restructured` or `relaxed` entry after an upgrade or a schema change tells you to check what the model now sees.
