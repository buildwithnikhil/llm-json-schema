#!/usr/bin/env node
// Reproduction: @langchain/anthropic silently drops tools whose schema has a root anyOf/oneOf/allOf.
//
// Needs @langchain/anthropic and @langchain/core installed in some folder, passed as LC_ENV:
//   mkdir /tmp/lc && cd /tmp/lc && npm init -y && npm i --ignore-scripts @langchain/anthropic @langchain/core zod
//   LC_ENV=/tmp/lc node scripts/repro-langchain-anthropic.mjs
//   LC_ENV=/tmp/lc ANTHROPIC_API_KEY=... node scripts/repro-langchain-anthropic.mjs   (also calls the model)
//
// The filter is in formatStructuredToolToAnthropic (src/chat_models.ts), added by PR #11310.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { convert } from "../dist/index.js";

const env = process.env.LC_ENV;
if (!env) {
  console.error("Set LC_ENV to a folder with @langchain/anthropic, @langchain/core and zod installed (see the header).");
  process.exit(2);
}
const req = createRequire(join(env, "package.json"));
const load = (id) => import(pathToFileURL(req.resolve(id)).href);
const { ChatAnthropic } = await load("@langchain/anthropic");
const { tool } = await load("@langchain/core/tools");
const { z } = await load("zod");
const version = req("@langchain/anthropic/package.json").version;

// 1. An MCP-style tool: JSON Schema with the variants of an "edit" action as a root oneOf.
const editSchema = {
  type: "object",
  oneOf: [
    { type: "object", properties: { mode: { const: "replace" }, path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["mode", "path", "old", "new"] },
    { type: "object", properties: { mode: { const: "append" }, path: { type: "string" }, text: { type: "string" } }, required: ["mode", "path", "text"] },
  ],
};
// 2. The same idea written in Zod: a union of objects becomes a root anyOf.
const zodUnion = z.union([
  z.object({ mode: z.literal("replace"), path: z.string(), old: z.string(), new: z.string() }),
  z.object({ mode: z.literal("append"), path: z.string(), text: z.string() }),
]);
const noop = async () => "ok";
const tools = [
  tool(noop, { name: "read_file", description: "Read a file", schema: z.object({ path: z.string() }) }),
  tool(noop, { name: "edit_file_json", description: "Edit a file", schema: editSchema }),
  tool(noop, { name: "edit_file_zod", description: "Edit a file", schema: zodUnion }),
];

const model = new ChatAnthropic({ model: process.env.MODEL ?? "claude-haiku-4-5", apiKey: process.env.ANTHROPIC_API_KEY ?? "unused" });
const sent = model.formatStructuredToolToAnthropic(tools);
console.log(`@langchain/anthropic ${version}: ${tools.length} tools bound, ${sent.length} sent to Anthropic: ${sent.map((t) => t.name).join(", ")}`);
console.log("No warning or error was raised for the missing tools.");

// The same tools with their schemas converted first: nothing is dropped, and the argument shape is unchanged.
const { toJsonSchema } = await load("@langchain/core/utils/json_schema");
const fixedTools = tools.map((t) =>
  tool(noop, { name: t.name, description: t.description, schema: convert(toJsonSchema(t.schema), { target: "anthropic", strict: false }).schema }),
);
const fixed = model.formatStructuredToolToAnthropic(fixedTools);
console.log(`\nWith llm-json-schema: ${fixed.length} sent: ${fixed.map((t) => t.name).join(", ")}`);
console.log("edit_file_zod input_schema:", JSON.stringify(fixed.find((t) => t.name === "edit_file_zod")?.input_schema));

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("\nSet ANTHROPIC_API_KEY to also ask the model to use the tool.");
  process.exit(0);
}
const ask = "Use the edit_file_zod tool to append the text 'hi' to a.txt.";
for (const [label, list] of [["Before", tools], ["After", fixedTools]]) {
  const res = await model.bindTools(list).invoke(ask);
  const calls = res.tool_calls?.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "no tool call";
  console.log(`\n${label}: ${calls}`);
}
