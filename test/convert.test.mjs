import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { convert, fromAny, resolveTarget, UnsupportedSchemaError } from "../dist/index.js";
import { corpus } from "./corpus.mjs";

/** Throws unless `schema` follows OpenAI's documented strict-mode subset. */
function assertOpenAIStrict(schema, caps = resolveTarget("openai")) {
  const allowed = new Set(caps.keywords);
  let props = 0;
  const walk = (s, at, depth, isRoot) => {
    assert.equal(typeof s, "object", `${at}: schema must be an object`);
    for (const k of Object.keys(s)) assert.ok(allowed.has(k), `${at}: keyword "${k}" isn't in OpenAI's strict subset`);
    if (s.$ref) {
      assert.deepEqual(Object.keys(s), ["$ref"], `${at}: $ref must have no siblings`);
      assert.match(s.$ref, /^#\/\$defs\//);
      return;
    }
    if (isRoot) {
      assert.equal(s.type, "object", "root must be type object");
      assert.equal(s.anyOf, undefined, "root must not be anyOf");
    }
    if (s.format !== undefined) assert.ok(caps.formats.includes(s.format), `${at}: format ${s.format}`);
    const types = s.type === undefined ? [] : [].concat(s.type);
    if (!s.anyOf) assert.ok(types.length > 0, `${at}: every non-union schema needs a type`);
    if (types.includes("object")) {
      assert.equal(s.additionalProperties, false, `${at}: additionalProperties must be false`);
      assert.deepEqual([...(s.required ?? [])].sort(), Object.keys(s.properties ?? {}).sort(), `${at}: every property must be required`);
      for (const [k, c] of Object.entries(s.properties ?? {})) {
        props++;
        assert.ok(depth + 1 <= 10, `${at}: nesting deeper than 10`);
        walk(c, `${at}/properties/${k}`, depth + 1, false);
      }
    }
    if (types.includes("array")) {
      assert.ok(s.items, `${at}: arrays need items`);
      walk(s.items, `${at}/items`, depth + 1, false);
    }
    if (types.includes("null") && Array.isArray(s.enum)) assert.ok(s.enum.includes(null), `${at}: nullable enum must list null`);
    if (s.anyOf) s.anyOf.forEach((b, i) => walk(b, `${at}/anyOf/${i}`, depth, false));
    if (s.$defs) for (const [k, d] of Object.entries(s.$defs)) walk(d, `#/$defs/${k}`, 1, false);
  };
  walk(schema, "#", 1, true);
  assert.ok(props <= 5000);
}


for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`strict-valid output: ${name} (${use})`, () => {
      const r = convert(schema, { target: "openai", use });
      assertOpenAIStrict(r.schema);
    });
  }
  test(`fine-tuned target: ${name}`, () => {
    const caps = resolveTarget("openai/ft:gpt-4.1-mini:acme::abc");
    assertOpenAIStrict(convert(schema, { target: caps }).schema, caps);
  });
}

test("field names per use", () => {
  assert.equal(convert({ type: "object", properties: {} }, { target: "openai" }).field, "tools[].function.parameters");
  assert.equal(convert({ type: "object", properties: {} }, { target: "openai", use: "output" }).field, "response_format.json_schema.schema");
});

test("an already-strict schema passes through unchanged with no losses", () => {
  const s = { type: "object", properties: { a: { type: "string", description: "A" }, n: { type: ["number", "null"] } }, required: ["a", "n"], additionalProperties: false };
  const r = convert(s, { target: "openai" });
  assert.deepEqual(r.schema, s);
  assert.deepEqual(r.losses, []);
  assert.deepEqual(r.decode({ a: "x", n: null }), { a: "x", n: null });
});

test("$ref with siblings is inlined, keeping the sibling description (langchainjs#11381)", () => {
  const r = convert(corpus["langchainjs#11381 $ref with sibling keywords"], { target: "openai" });
  assert.deepEqual(r.schema.properties.a, { type: "string", enum: ["c", "f"], description: 'unit A Default: "c".' });
  assert.equal(r.schema.$defs, undefined);
});

test("optional fields become nullable and decode() removes the nulls (pi#7010)", () => {
  const r = convert(corpus["pi#7010 object with only optional properties"], { target: "openai" });
  assert.deepEqual(r.schema.properties.options.required, ["verbose", "depth"]);
  assert.deepEqual(r.decode({ options: { verbose: true, depth: null } }), { options: { verbose: true } });
  assert.deepEqual(r.decode({ options: null }), {});
  assert.ok(r.losses.some((l) => l.action === "restructured" && l.path === "#/properties/options/properties/depth"));
});

test("optional and already nullable: null is kept, not removed", () => {
  const r = convert({ type: "object", properties: { a: { type: ["string", "null"] } } }, { target: "openai" });
  assert.deepEqual(r.decode({ a: null }), { a: null });
  assert.equal(r.losses[0].action, "relaxed");
});

test("vendor keywords are dropped, examples and constraints move into the description (composio#4750)", () => {
  const r = convert(corpus["composio#4750 vendor keywords"], { target: "openai" });
  const u = r.schema.properties.user_id;
  assert.deepEqual(Object.keys(u).sort(), ["description", "type"]);
  assert.equal(u.description, 'Example: "me".');
  assert.deepEqual(r.schema.properties.count.enum, [5, null]); // optional, so nullable
  const dropped = r.losses.filter((l) => l.action === "dropped").map((l) => l.keyword).sort();
  assert.deepEqual(dropped, ["file_uploadable", "human_parameter_description", "human_parameter_name"]);
});

test("a never-present property is removed (cloudflare#378)", () => {
  const r = convert(corpus["cloudflare#378 never property"], { target: "openai" });
  assert.deepEqual(Object.keys(r.schema.properties), ["a"]);
});

test("maps round-trip through {key, value} entries", () => {
  const r = convert(corpus["map, free-form object and any"], { target: "openai" });
  const out = r.decode({ scores: [{ key: "x", value: 1 }, { key: "y", value: 2 }], extra: '{"k":true}', raw: "[1,2]" });
  assert.deepEqual(out, { scores: { x: 1, y: 2 }, extra: { k: true }, raw: [1, 2] });
  assert.equal(r.check(out).valid, true);
});

test("patternProperties keep the key pattern", () => {
  const r = convert(corpus.patternProperties, { target: "openai" });
  assert.equal(r.schema.properties.value.items.properties.key.pattern, "^x-");
  assert.deepEqual(r.decode({ value: [{ key: "x-a", value: "1" }] }), { "x-a": "1" });
});

test("tuples round-trip through objects", () => {
  const r = convert(corpus["draft-07 definitions, tuple items and nullable"], { target: "openai" });
  assert.deepEqual(r.schema.properties.at.required, ["0", "1"]);
  const out = r.decode({ at: { 0: 1.5, 1: 2 }, note: null });
  assert.deepEqual(out, { at: [1.5, 2], note: null }); // note was already nullable, so null is kept
  assert.equal(r.check(out).valid, true);
  assert.equal(r.check({ at: [1, 2], note: "x".repeat(21) }).valid, false);
});

test("root union and root array are wrapped and unwrapped", () => {
  const u = convert(corpus["root discriminated union"], { target: "openai" });
  assert.deepEqual(Object.keys(u.schema.properties), ["value"]);
  assert.deepEqual(u.decode({ value: { kind: "b", n: 1 } }), { kind: "b", n: 1 });
  const a = convert(corpus["root array"], { target: "openai", use: "output" });
  assert.deepEqual(a.decode({ value: ["a@b.co"] }), ["a@b.co"]);
});

test("anyOf decode picks the branch that matches", () => {
  const r = convert({ type: "object", properties: { v: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "integer" } }] } }, required: ["v"] }, { target: "openai" });
  assert.deepEqual(r.decode({ v: "plain" }), { v: "plain" });
  assert.deepEqual(r.decode({ v: [{ key: "a", value: 1 }] }), { v: { a: 1 } });
});

test("recursive schemas keep $defs, decode recurses", () => {
  const r = convert({ $defs: { N: { type: "object", properties: { tags: { type: "object", additionalProperties: { type: "string" } }, kids: { type: "array", items: { $ref: "#/$defs/N" } } }, required: ["kids"] } }, $ref: "#/$defs/N" }, { target: "openai" });
  assert.ok(r.schema.$defs.N);
  const out = r.decode({ tags: [{ key: "a", value: "1" }], kids: [{ tags: null, kids: [] }] });
  assert.deepEqual(out, { tags: { a: "1" }, kids: [{ kids: [] }] });
  const root = convert(corpus["root recursion with #"], { target: "openai" });
  assert.ok(root.schema.$defs.Root);
  assert.equal(root.schema.properties.parent.anyOf[0].$ref, "#/$defs/Root");
});

test("allOf is merged; contradictory allOf throws", () => {
  const r = convert(corpus["allOf intersection"], { target: "openai" });
  assert.deepEqual(Object.keys(r.schema.properties), ["a", "b"]);
  assert.match(r.schema.properties.a.description, /At least 2 characters\. At most 5 characters\./);
  assert.throws(() => convert({ allOf: [{ type: "string" }, { type: "number" }] }, { target: "openai" }), UnsupportedSchemaError);
});

test("check() enforces what the target couldn't: oneOf exclusivity, uniqueItems, format", () => {
  const r = convert({ type: "object", properties: { v: { oneOf: [{ type: "number" }, { type: "integer" }] }, t: { type: "array", items: { type: "string" }, uniqueItems: true }, u: { type: "string", format: "uri" } }, required: ["v", "t", "u"] }, { target: "openai" });
  const res = r.check({ v: 2, t: ["a", "a"], u: "not a uri" });
  assert.equal(res.valid, false);
  assert.deepEqual(res.errors.map((e) => e.path).sort(), ["", "/t", "/u", "/v"].filter((p) => p !== "").sort());
});

test("errors: external $ref, too deep, too many enum values, unknown target, lossless", () => {
  assert.throws(() => convert({ $ref: "https://example.com/s.json" }, { target: "openai" }), /external \$ref/);
  let deep = { type: "string" };
  for (let i = 0; i < 11; i++) deep = { type: "object", properties: { x: deep }, required: ["x"] };
  assert.throws(() => convert(deep, { target: "openai" }), /deeper than the limit of 10/);
  assert.throws(() => convert({ type: "object", properties: { e: { enum: Array.from({ length: 1001 }, (_, i) => i) } } }, { target: "openai" }), /enum values exceed/);
  assert.throws(() => convert({}, { target: "nope" }), /Unknown provider/);
  assert.throws(() => convert({}, { target: "google" }), /isn't supported yet/);
  assert.throws(() => convert({ type: "object", properties: { a: { type: "string", minLength: 1 } }, required: ["a"] }, { target: "openai", lossless: true }), UnsupportedSchemaError);
  convert({ type: "object", properties: { a: { const: 1 } }, required: ["a"] }, { target: "openai", lossless: true }); // only rewrites
});

test("custom capabilities: a target without recursion rejects recursive schemas", () => {
  const caps = { ...resolveTarget("openai"), id: "custom", recursion: false };
  assert.throws(() => convert(corpus["recursive tree"], { target: caps }), /recursive schemas/);
});

test("custom capabilities: open schemas and optional fields are kept when the target allows them", () => {
  const caps = { ...resolveTarget("openai"), id: "loose", allRequired: false, closedObjects: false, rootObject: false, openSchemas: true, keywords: [...resolveTarget("openai").keywords, "minLength"] };
  const s = { type: "object", properties: { a: { type: "string", minLength: 1 }, any: {} } };
  const r = convert(s, { target: caps });
  assert.deepEqual(r.schema, s);
  assert.deepEqual(r.losses, []);
});

test("fine-tuned models lose pattern, format and bounds to the description", () => {
  const r = convert({ type: "object", properties: { d: { type: "string", format: "date", pattern: "^2" }, n: { type: "integer", minimum: 1 } }, required: ["d", "n"] }, { target: "openai/ft:gpt-4.1:acme" });
  assert.deepEqual(Object.keys(r.schema.properties.d).sort(), ["description", "type"]);
  assert.equal(r.schema.properties.n.description, "Minimum 1.");
});

test("fromAny reads Zod 4 through Standard JSON Schema", () => {
  const s = z.object({ name: z.string().min(3), kind: z.enum(["a", "b"]).default("a") });
  const input = fromAny(s);
  assert.deepEqual(input.required, ["name"]);
  assert.deepEqual(fromAny(s, { io: "output" }).required, ["name", "kind"]);
  const r = convert(input, { target: "openai" });
  assertOpenAIStrict(r.schema);
  const value = r.decode({ name: "Ada", kind: null });
  assert.deepEqual(value, { name: "Ada" });
  assert.equal(s.safeParse(value).success, true);
  assert.deepEqual(fromAny({ type: "string" }), { type: "string" });
  assert.throws(() => fromAny({ "~standard": { validate() {} } }), /Standard JSON Schema/);
});

test("input is not mutated", () => {
  const s = structuredClone(corpus["composio#4750 vendor keywords"]);
  convert(s, { target: "openai" });
  assert.deepEqual(s, corpus["composio#4750 vendor keywords"]);
});
