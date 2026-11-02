import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { convert, fromAny, resolveTarget, UnsupportedSchemaError } from "../dist/index.js";
import { corpus } from "./corpus.mjs";

/** Throws unless `schema` follows Anthropic's documented strict subset. */
function assertAnthropicStrict(schema) {
  const caps = resolveTarget("anthropic");
  const allowed = new Set(caps.keywords);
  let optional = 0;
  let unions = 0;
  const walk = (s, at, isRoot) => {
    for (const k of Object.keys(s)) assert.ok(allowed.has(k), `${at}: keyword "${k}" isn't in Anthropic's strict subset`);
    for (const [k, rule] of Object.entries(caps.rules)) if (k in s) assert.ok(rule(s[k]), `${at}: ${k}=${JSON.stringify(s[k])} isn't accepted`);
    if (s.format !== undefined) assert.ok(caps.formats.includes(s.format), `${at}: format ${s.format}`);
    if (s.$ref) {
      assert.deepEqual(Object.keys(s), ["$ref"]);
      return;
    }
    if (isRoot) assert.equal(s.type, "object", "root must be type object");
    const types = s.type === undefined ? [] : [].concat(s.type);
    if (types.includes("object")) {
      assert.equal(s.additionalProperties, false, `${at}: additionalProperties must be false`);
      const req = new Set(s.required ?? []);
      for (const [k, c] of Object.entries(s.properties ?? {})) {
        if (!req.has(k)) optional++;
        if (c.anyOf || (Array.isArray(c.type) && c.type.length > 1)) unions++;
        walk(c, `${at}/properties/${k}`, false);
      }
    }
    if (types.includes("array")) walk(s.items, `${at}/items`, false);
    if (s.anyOf) s.anyOf.forEach((b, i) => walk(b, `${at}/anyOf/${i}`, false));
    if (s.$defs) for (const [k, d] of Object.entries(s.$defs)) walk(d, `#/$defs/${k}`, false);
  };
  walk(schema, "#", true);
  assert.ok(optional <= 24 && unions <= 16);
}

const recursive = new Set(["recursive tree", "root recursion with #"]);
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`anthropic strict: ${name} (${use})`, () => {
      if (recursive.has(name)) {
        assert.throws(() => convert(schema, { target: "anthropic/claude-sonnet-4-5", use }), /recursive schemas/);
        return;
      }
      assertAnthropicStrict(convert(schema, { target: "anthropic/claude-sonnet-4-5", use }).schema);
    });
  }
}

test("anthropic strict keeps optional fields optional (no nullable rewrite)", () => {
  const r = convert(corpus["pi#7010 object with only optional properties"], { target: "anthropic" });
  assert.equal(r.schema.properties.options.required, undefined);
  assert.equal(r.schema.properties.options.properties.verbose.type, "boolean");
  assert.deepEqual(r.decode({ options: { verbose: true } }), { options: { verbose: true } });
  assert.equal(r.field, "tools[].input_schema");
  assert.equal(convert({ type: "object", properties: {} }, { target: "anthropic", use: "output" }).field, "output_config.format.schema");
});

test("anthropic strict: const, default and uri are kept; bounds, minItems > 1 and lookahead patterns are described", () => {
  const r = convert({
    type: "object",
    properties: {
      kind: { const: "a" },
      site: { type: "string", format: "uri", default: "https://x.dev" },
      n: { type: "integer", minimum: 1, maximum: 9 },
      list: { type: "array", items: { type: "string" }, minItems: 2 },
      one: { type: "array", items: { type: "string" }, minItems: 1 },
      code: { type: "string", pattern: "^(?!x)[a-z]+$" },
      ok: { type: "string", pattern: "^[a-z]{2,4}$" },
    },
    required: ["kind", "site", "n", "list", "one", "code", "ok"],
  }, { target: "anthropic" });
  const p = r.schema.properties;
  assert.deepEqual(p.kind, { const: "a", type: "string" });
  assert.deepEqual(p.site, { type: "string", format: "uri", default: "https://x.dev" });
  assert.equal(p.n.description, "Minimum 1. Maximum 9.");
  assert.equal(p.list.minItems, undefined);
  assert.equal(p.one.minItems, 1);
  assert.equal(p.code.pattern, undefined);
  assert.equal(p.ok.pattern, "^[a-z]{2,4}$");
  assert.equal(r.check({ kind: "a", site: "https://x.dev", n: 10, list: ["a"], one: ["a"], code: "xa", ok: "ab" }).errors.length, 3);
});

test("anthropic strict: object enum values are relaxed to the description", () => {
  const r = convert({ type: "object", properties: { v: { enum: [{ a: 1 }, { a: 2 }] } }, required: ["v"] }, { target: "anthropic" });
  assert.equal(r.schema.properties.v.enum, undefined);
  assert.match(r.schema.properties.v.description, /One of: \{"a":1\}, \{"a":2\}\./);
  assert.equal(r.check({ v: { a: 3 } }).valid, false);
});

test("anthropic strict: more than 24 optional properties throws", () => {
  const properties = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: "string" }]));
  assert.throws(() => convert({ type: "object", properties }, { target: "anthropic" }), /25 optional properties exceed the limit of 24/);
});

test("anthropic strict isn't available for Claude 3 models", () => {
  assert.throws(() => convert({ type: "object" }, { target: "anthropic/claude-3-5-sonnet-20241022" }), /strict: false/);
  convert({ type: "object" }, { target: "anthropic/claude-3-5-sonnet-20241022", strict: false });
});

test("anthropic strict with Zod", () => {
  const s = z.object({ query: z.string().min(1), limit: z.number().int().max(50).optional(), mode: z.enum(["fast", "deep"]).default("fast") });
  const r = convert(fromAny(s), { target: "anthropic" });
  assertAnthropicStrict(r.schema);
  assert.equal(s.safeParse(r.decode({ query: "x" })).success, true);
});

test("non-strict: a schema that is already valid is sent exactly as written", () => {
  const s = { type: "object", properties: { a: { type: "string", minLength: 2, not: { const: "x" } }, b: { oneOf: [{ type: "string" }, { type: "number" }] } }, if: { required: ["a"] }, then: { required: ["b"] } };
  for (const target of ["anthropic", "openai"]) {
    const r = convert(s, { target, strict: false });
    assert.deepEqual(r.schema, s);
    assert.deepEqual(r.losses, []);
  }
});

test("non-strict: a root union of objects is merged without changing the output shape (9router#4075, opencode#47543)", () => {
  const u = convert(corpus["root discriminated union"], { target: "anthropic", strict: false });
  assert.deepEqual(u.schema, { type: "object", properties: { kind: { enum: ["a", "b"] }, n: { type: "number" } }, required: ["kind"] });
  assert.equal(u.losses[0].action, "relaxed");
  assert.deepEqual(u.decode({ kind: "b", n: 1 }), { kind: "b", n: 1 }); // nothing to decode
  assert.equal(u.check({ kind: "b", n: 1 }).valid, true);
  assert.equal(u.check({ kind: "b" }).valid, false); // the exact variants are still enforced
  // Variants behind $ref, with a description at the root.
  const r = convert({ description: "Edit", $defs: { A: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }, oneOf: [{ $ref: "#/$defs/A" }, { type: "object", properties: { path: { type: "string" }, all: { type: "boolean" } }, required: ["path", "all"] }] }, { target: "anthropic", strict: false });
  assert.equal(r.schema.description, "Edit");
  assert.deepEqual(r.schema.required, ["path"]);
  assert.deepEqual(Object.keys(r.schema.properties), ["path", "all"]);
});

test("non-strict: a root union that isn't all objects is wrapped; a root allOf of objects is merged", () => {
  const w = convert({ anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] }, { target: "anthropic", strict: false });
  assert.deepEqual(Object.keys(w.schema.properties), ["value"]);
  assert.deepEqual(w.decode({ value: "x" }), "x");
  const a = convert(corpus["allOf intersection"], { target: "anthropic", strict: false });
  assert.equal(a.schema.type, "object");
  assert.deepEqual(Object.keys(a.schema.properties), ["a", "b"]);
  const ref = convert(corpus["recursive tree"], { target: "anthropic", strict: false });
  assert.equal(ref.schema.type, "object");
  assert.ok(ref.schema.$defs.Node);
  assert.equal(ref.schema.properties.value.$ref, "#/$defs/Node");
});

test("capabilities objects work as targets", () => {
  const caps = { ...resolveTarget("anthropic"), id: "my-proxy", recursion: true };
  assert.ok(convert(corpus["recursive tree"], { target: caps }).schema.$defs);
  assert.throws(() => convert(corpus["recursive tree"], { target: "anthropic" }), UnsupportedSchemaError);
});
