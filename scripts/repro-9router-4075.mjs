#!/usr/bin/env node
// Reproduction for decolua/9router#4075: Anthropic rejects tool input_schema with a top-level anyOf/oneOf/allOf.
//
//   node scripts/repro-9router-4075.mjs                       prints the schemas (no network)
//   ANTHROPIC_API_KEY=... node scripts/repro-9router-4075.mjs  also sends both to the Messages API (non-strict tools)
//
// 9router's openai-to-claude translator copies `function.parameters` straight into `input_schema`
// (open-sse/translator/request/openai-to-claude.js, `input_schema: toolData.parameters || ...`).
import { convert } from "../dist/index.js";

// An OpenAI-format tool as an MCP client might send it: the variants of an "edit" action as a root oneOf.
const parameters = {
  description: "Edit a file",
  oneOf: [
    {
      type: "object",
      properties: { mode: { const: "replace" }, path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["mode", "path", "old", "new"],
    },
    {
      type: "object",
      properties: { mode: { const: "append" }, path: { type: "string" }, text: { type: "string" } },
      required: ["mode", "path", "text"],
    },
  ],
};

const r = convert(parameters, { target: "anthropic", strict: false });

console.log("Today 9router sends input_schema =", JSON.stringify(parameters));
console.log("\nWith convert(parameters, { target: \"anthropic\", strict: false }):");
console.log("input_schema =", JSON.stringify(r.schema));
for (const l of r.losses) console.log(`  ${l.action}: ${l.note}`);

// The model's arguments keep their shape, so a proxy can stream them through untouched.
const args = { mode: "append", path: "a.txt", text: "hi" };
console.log("\nArguments need no decoding:", JSON.stringify(r.decode(args)) === JSON.stringify(args));
console.log("check() still enforces the exact variants:", r.check(args).valid, r.check({ mode: "append", path: "a.txt" }).valid);

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log("\nSet ANTHROPIC_API_KEY to send both schemas to the API.");
  process.exit(0);
}
const model = process.env.MODEL ?? "claude-haiku-4-5";
async function send(label, inputSchema) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with one word." }],
      tools: [{ name: "edit_file", description: "Edit a file", input_schema: inputSchema }],
    }),
  });
  const body = await res.text();
  console.log(`\n${label}: HTTP ${res.status}${res.ok ? "" : ` ${body.slice(0, 300)}`}`);
  return res.status;
}
const before = await send("Before (as 9router sends it today)", parameters);
const after = await send("After (converted)", r.schema);
process.exit(before === 400 && after === 200 ? 0 : 1);
