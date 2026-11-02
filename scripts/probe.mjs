#!/usr/bin/env node
// Checks the rules table against the live API.
//
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GEMINI_API_KEY=... node scripts/probe.mjs [provider/model ...]
//   (default: openai/gpt-4.1-mini anthropic/claude-haiku-4-5 google/gemini-3.5-flash-lite google-openapi/gemini-3.5-flash-lite;
//   providers without a key are skipped. A Gemini key is free from Google AI Studio.)
//
// Part 1 sends one schema per keyword as a strict tool and records accepted / rejected. Part 2 sends every
// converted schema from the test corpus, which must all be accepted. Results go to probe-results/<date>.json
// plus a Markdown table. Exits 1 when the API disagrees with the table, so CI can open an issue.
//
// Cost: schemas are validated before generation, so a rejected probe returns 400 without running the model;
// accepted probes generate at most 16 tokens. Check your provider's billing for rejected requests.
import { mkdirSync, writeFileSync } from "node:fs";
import { convert, resolveTarget } from "../dist/index.js";
import { corpus } from "../test/corpus.mjs";

const gemini = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const keys = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, google: gemini, "google-openapi": gemini };
const requested = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5", "google/gemini-3.5-flash-lite", "google-openapi/gemini-3.5-flash-lite"];
const models = requested.filter((m) => {
  const provider = m.split("/")[0];
  if (!(provider in keys)) throw new Error(`No probe sender for ${provider}`);
  if (!keys[provider]) console.error(`Skipping ${m}: set ${provider.startsWith("google") ? "GEMINI" : provider.toUpperCase()}_API_KEY.`);
  return Boolean(keys[provider]);
});
if (models.length === 0) {
  console.error("No API keys set: nothing to probe.");
  process.exit(2);
}

const obj = (props, extra = {}) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false, ...extra });
const one = (s) => obj({ x: s });

// Each probe isolates one keyword. `keyword` is what the rules table is asked about.
const probes = [
  { keyword: "baseline", schema: one({ type: "string" }), expect: true },
  { keyword: "const", schema: one({ type: "string", const: "a" }) },
  { keyword: "title", schema: one({ type: "string", title: "X" }) },
  { keyword: "default", schema: one({ type: "string", default: "a" }) },
  { keyword: "examples", schema: one({ type: "string", examples: ["a"] }) },
  { keyword: "minLength", schema: one({ type: "string", minLength: 1 }) },
  { keyword: "maxLength", schema: one({ type: "string", maxLength: 9 }) },
  { keyword: "pattern", schema: one({ type: "string", pattern: "^[a-z]+$" }) },
  { keyword: "pattern (lookahead)", schema: one({ type: "string", pattern: "^(?=a)a+$" }), note: true },
  { keyword: "pattern (\\p{L} escape)", schema: one({ type: "string", pattern: "^\\p{L}+$" }), note: true },
  { keyword: "root anyOf (non-strict)", schema: { anyOf: [obj({ a: { type: "string" } })] }, note: true, strict: false },
  { keyword: "format", schema: one({ type: "string", format: "date-time" }) },
  { keyword: "format: uri", schema: one({ type: "string", format: "uri" }), formatValue: "uri" },
  { keyword: "minimum", schema: one({ type: "number", minimum: 0 }) },
  { keyword: "multipleOf", schema: one({ type: "number", multipleOf: 2 }) },
  { keyword: "minItems", schema: one({ type: "array", items: { type: "string" }, minItems: 1 }) },
  { keyword: "minItems: 2", schema: one({ type: "array", items: { type: "string" }, minItems: 2 }), minItemsValue: 2 },
  { keyword: "maxItems", schema: one({ type: "array", items: { type: "string" }, maxItems: 3 }) },
  { keyword: "uniqueItems", schema: one({ type: "array", items: { type: "string" }, uniqueItems: true }) },
  { keyword: "prefixItems", schema: one({ type: "array", prefixItems: [{ type: "string" }] }) },
  { keyword: "minProperties", schema: one({ ...obj({ a: { type: "string" } }), minProperties: 1 }) },
  { keyword: "oneOf", schema: one({ oneOf: [{ type: "string" }, { type: "number" }] }) },
  { keyword: "allOf", schema: one({ allOf: [{ type: "string" }] }) },
  { keyword: "not", schema: one({ type: "string", not: { const: "a" } }) },
  { keyword: "type array (null)", schema: one({ type: ["string", "null"] }), expect: true },
  { keyword: "type array (two types)", schema: one({ type: ["string", "number"] }), note: true },
  { keyword: "enum without type", schema: one({ enum: ["a", 1] }), note: true },
  { keyword: "$ref sibling description", schema: { ...one({ $ref: "#/$defs/S", description: "d" }), $defs: { S: { type: "string" } } }, expect: false, rule: "refSiblings" },
  { keyword: "recursion", schema: { ...obj({ kids: { type: "array", items: { $ref: "#" } } }) }, expect: true, rule: "recursion" },
  { keyword: "root anyOf", schema: { anyOf: [obj({ a: { type: "string" } })] }, expect: false, rule: "rootObject" },
  { keyword: "optional field", schema: { ...one({ type: "string" }), required: [] }, expect: false, rule: "allRequired" },
  { keyword: "open object", schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] }, expect: false, rule: "closedObjects" },
  { keyword: "empty schema", schema: one({}), expect: false, rule: "openSchemas" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries busy and rate-limited responses (429, 500, 503) with backoff; free-tier keys hit these often.
async function send(target, parameters, strict = true) {
  for (let attempt = 0; ; attempt++) {
    await sleep(Number(process.env.PROBE_DELAY_MS ?? 1500));
    try {
      return await sendOnce(target, parameters, strict);
    } catch (e) {
      const busy = /HTTP (429|500|503)/.test(e.message);
      if (!busy || attempt >= 5) throw e;
      const wait = 5000 * 2 ** attempt;
      console.error(`  (busy: ${e.message.match(/HTTP \d+/)[0]}, retrying in ${wait / 1000}s)`);
      await sleep(wait);
    }
  }
}

async function sendOnce(target, parameters, strict = true) {
  const [provider, ...rest] = target.split("/");
  const model = rest.join("/");
  if (provider === "google" || provider === "google-openapi") {
    const field = provider === "google" ? "parametersJsonSchema" : "parameters";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": gemini },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with one word." }] }],
        tools: [{ functionDeclarations: [{ name: "probe", description: "Probe tool.", [field]: parameters }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    });
    if (res.ok) return { accepted: true };
    const body = await res.text();
    if (res.status === 400) return { accepted: false, error: body.slice(0, 300) };
    throw new Error(`${target}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const res =
    provider === "openai"
      ? await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${keys.openai}` },
          body: JSON.stringify({
            model,
            max_completion_tokens: 16,
            messages: [{ role: "user", content: "Reply with one word." }],
            tools: [{ type: "function", function: { name: "probe", parameters, strict } }],
          }),
        })
      : await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": keys.anthropic, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model,
            max_tokens: 16,
            messages: [{ role: "user", content: "Reply with one word." }],
            tools: [{ name: "probe", description: "Probe tool.", input_schema: parameters, ...(strict ? { strict: true } : {}) }],
          }),
        });
  if (res.ok) return { accepted: true };
  const body = await res.text();
  if (res.status === 400) return { accepted: false, error: body.slice(0, 300) };
  throw new Error(`${model}: HTTP ${res.status} ${body.slice(0, 300)}`);
}

const results = [];
let mismatches = 0;
for (const model of models) {
  const caps = resolveTarget(model);
  const allow = caps.keywords === "any" ? { has: () => true } : new Set(caps.keywords);
  const formatOk = (f) => caps.formats === "any" || caps.formats.includes(f);
  const ruleOk = (p) => {
    const k = p.keyword;
    const v = p.schema.properties?.x?.[k];
    return !caps.rules?.[k] || v === undefined || caps.rules[k](v);
  };
  // The keyword probes are written in JSON Schema; the OpenAPI dialect only runs the converted corpus.
  for (const p of caps.upperCaseTypes ? [] : probes) {
    let expected = p.expect;
    if (expected === undefined && !p.note) expected = p.formatValue ? allow.has("format") && formatOk(p.formatValue) : allow.has(p.keyword) && ruleOk(p);
    if (p.minItemsValue !== undefined) expected = allow.has("minItems") && (!caps.rules?.minItems || caps.rules.minItems(p.minItemsValue));
    if (p.rule) expected = p.rule === "allRequired" || p.rule === "openSchemas" ? caps[p.rule] === false : p.rule === "closedObjects" ? !caps.closedObjects : p.rule === "rootObject" ? !caps.rootObject : caps[p.rule];
    const r = await send(model, p.schema, p.strict ?? true);
    const ok = expected === undefined || r.accepted === expected;
    if (!ok) mismatches++;
    results.push({ model, part: "keyword", probe: p.keyword, expected, ...r, ok });
    console.log(`${ok ? " " : "!"} ${model}  ${p.keyword.padEnd(28)} ${r.accepted ? "accepted" : "rejected"}${expected === undefined ? " (recorded only)" : ok ? "" : `  EXPECTED ${expected ? "accepted" : "rejected"}`}`);
  }
  for (const [name, schema] of Object.entries(corpus)) {
    let converted;
    try {
      converted = convert(schema, { target: caps }).schema;
    } catch (e) {
      if (e.name !== "UnsupportedSchemaError") throw e;
      console.log(`  ${model}  converted: ${name}  skipped (${e.reason})`);
      continue;
    }
    const r = await send(model, converted);
    if (!r.accepted) mismatches++;
    results.push({ model, part: "converted", probe: name, expected: true, ...r, ok: r.accepted });
    console.log(`${r.accepted ? " " : "!"} ${model}  converted: ${name}${r.accepted ? "" : `  REJECTED ${r.error}`}`);
  }
}

const date = new Date().toISOString().slice(0, 10);
mkdirSync("probe-results", { recursive: true });
writeFileSync(`probe-results/${date}.json`, JSON.stringify({ date, models, results }, null, 2));
const rows = results.filter((r) => r.part === "keyword");
const md = [
  `| Keyword | ${models.join(" | ")} |`,
  `|---|${models.map(() => "---").join("|")}|`,
  ...probes.map((p) => `| ${p.keyword} | ${models.map((m) => (rows.find((r) => r.model === m && r.probe === p.keyword)?.accepted ? "✅" : "❌")).join(" | ")} |`),
  "",
  `Checked ${date}.`,
].join("\n");
writeFileSync(`probe-results/${date}.md`, md + "\n");
console.log(`\n${mismatches === 0 ? "All probes match the rules table." : `${mismatches} mismatch(es) with the rules table.`}`);
process.exit(mismatches === 0 ? 0 : 1);
