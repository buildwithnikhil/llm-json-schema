import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { convert, fromAny, resolveTarget } from "../dist/index.js";
import { corpus } from "./corpus.mjs";
import { assertConforms } from "./conformance.mjs";

const target = "deepseek/deepseek-v4-pro";
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`deepseek strict: ${name} (${use})`, () => {
      const r = convert(schema, { target, use });
      assertConforms(r.schema, r.target);
      assert.ok(!JSON.stringify(r.schema).includes("$defs"), "uses $def, not $defs");
    });
  }
}

test("deepseek: fields, strict and non-strict", () => {
  assert.equal(convert({ type: "object" }, { target }).field, "tools[].function.parameters");
  assert.equal(convert({ type: "object" }, { target, use: "output" }).field, "text.format.schema");
  const s = { type: "object", properties: { a: { type: "string", minLength: 1 } } };
  assert.deepEqual(convert(s, { target, strict: false }).schema, s);
});

test("deepseek strict: recursion uses $def, nullable uses anyOf with null, decode removes the nulls", () => {
  const r = convert(corpus["root recursion with #"], { target });
  assert.ok(r.schema.$def.Root);
  assert.equal(r.schema.$defs, undefined);
  assert.deepEqual(r.schema.properties.parent, { anyOf: [{ $ref: "#/$def/Root" }, { type: "null" }] });
  assert.deepEqual(r.decode({ name: "a", parent: { name: "b", parent: null } }), { name: "a", parent: { name: "b" } });
});

test("deepseek strict: string and array bounds move to the description; number bounds, pattern and const on numbers stay", () => {
  const r = convert({
    type: "object",
    properties: {
      name: { type: "string", minLength: 2, pattern: "^[a-z]+$", format: "email" },
      tags: { type: "array", items: { type: "string" }, minItems: 1 },
      n: { type: "number", minimum: 0, multipleOf: 0.5 },
      v: { const: 3 },
      k: { const: "a" },
    },
    required: ["name", "tags", "n", "v", "k"],
  }, { target });
  const p = r.schema.properties;
  assert.equal(p.name.minLength, undefined);
  assert.equal(p.name.pattern, "^[a-z]+$");
  assert.equal(p.name.format, "email");
  assert.equal(p.tags.minItems, undefined);
  assert.deepEqual([p.n.minimum, p.n.multipleOf], [0, 0.5]);
  assert.equal(p.v.const, 3);
  assert.deepEqual(p.k.enum, ["a"]);
});

test("deepseek strict with Zod", () => {
  const s = z.object({ q: z.string().min(1), limit: z.number().int().max(50).optional() });
  const r = convert(fromAny(s), { target });
  assertConforms(r.schema, resolveTarget(target));
  assert.equal(s.safeParse(r.decode({ q: "x", limit: null })).success, true);
});
