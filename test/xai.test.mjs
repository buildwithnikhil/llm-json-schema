import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, resolveTarget } from "../dist/index.js";
import { corpus } from "./corpus.mjs";
import { assertConforms } from "./conformance.mjs";

const recursive = new Set(["recursive tree", "root recursion with #"]);
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`xai: ${name} (${use})`, () => {
      if (recursive.has(name)) return assert.throws(() => convert(schema, { target: "xai/grok-4.7", use }), /recursive/);
      const r = convert(schema, { target: "xai/grok-4.7", use });
      assertConforms(r.schema, r.target);
    });
  }
}

test("xai: one mode, aliases and fields", () => {
  const caps = resolveTarget("xai/grok-4.7");
  assert.equal(caps.provider, "xai");
  assert.equal(resolveTarget("grok", { strict: false }).id, "grok");
  assert.deepEqual(resolveTarget("xai", { strict: false }).keywords, caps.keywords);
  assert.equal(convert({ type: "object" }, { target: "xai" }).field, "tools[].function.parameters");
});

test("xai: optional fields stay optional; bounds, const and uri are kept", () => {
  const s = { type: "object", properties: { name: { type: "string", minLength: 2, maxLength: 20 }, kind: { const: "a" }, site: { type: "string", format: "uri" }, n: { type: "integer", minimum: 1 } }, required: ["name"] };
  const r = convert(s, { target: "xai" });
  assert.deepEqual(r.schema.required, ["name"]);
  assert.deepEqual(r.schema.properties.name, s.properties.name);
  assert.deepEqual(r.schema.properties.kind, { const: "a", type: "string" });
  assert.equal(r.schema.properties.site.format, "uri");
  assert.equal(r.schema.properties.n.minimum, 1);
});

test("xai: patterns are full-match, so unanchored ones are widened; unsupported regex features are described", () => {
  const r = convert(
    {
      type: "object",
      properties: {
        contains: { type: "string", pattern: "@" },
        prefix: { type: "string", pattern: "^ab" },
        anchored: { type: "string", pattern: "^[a-z]+$" },
        either: { type: "string", pattern: "a|b" },
        look: { type: "string", pattern: "^(?!x)[a-z]+$" },
        prop: { type: "string", pattern: "^\\p{L}+$" },
        word: { type: "string", pattern: "\\bcat\\b" },
      },
    },
    { target: "xai" },
  );
  const p = r.schema.properties;
  assert.equal(p.contains.pattern, "^.*(?:@).*$");
  assert.equal(p.prefix.pattern, "^(?:ab).*$");
  assert.equal(p.anchored.pattern, "^[a-z]+$");
  assert.equal(p.either.pattern, "^.*(?:a|b).*$");
  for (const k of ["look", "prop", "word"]) {
    assert.equal(p[k].pattern, undefined, k);
    assert.match(p[k].description, /Must match the regular expression/);
  }
  // The widened patterns accept exactly what the original accepts, anywhere in the string.
  assert.ok(new RegExp(p.contains.pattern, "s").test("me@x.dev"));
  assert.equal(r.check({ look: "xyz" }).valid, false);
});

test("xai: free-form objects get additionalProperties: true (objects are closed by default)", () => {
  const r = convert({ type: "object", properties: { meta: { type: "object" }, tags: { type: "object", additionalProperties: { type: "string" } }, fixed: { type: "object", properties: { a: { type: "string" } } } } }, { target: "xai" });
  assert.deepEqual(r.schema.properties.meta, { type: "object", additionalProperties: true });
  assert.deepEqual(r.schema.properties.tags, { type: "object", additionalProperties: { type: "string" } });
  assert.equal(r.schema.properties.fixed.additionalProperties, undefined);
});

test("xai: allOf is merged, oneOf becomes anyOf, not is dropped (best effort on xAI), array items become prefixItems", () => {
  const r = convert({ type: "object", properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] }, t: { type: "array", items: [{ type: "string" }, { type: "number" }] }, s: { type: "string", not: { const: "x" } } }, allOf: [{ required: ["v"] }] }, { target: "xai" });
  assert.ok(r.schema.properties.v.anyOf);
  assert.deepEqual(r.schema.properties.t.prefixItems, [{ type: "string" }, { type: "number" }]);
  assert.equal(r.schema.properties.s.not, undefined);
  assert.deepEqual(r.schema.required, ["v"]);
  assert.equal(r.check({ v: "a", s: "x" }).valid, false);
});
