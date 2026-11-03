import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { convert, fromAny, resolveTarget } from "../dist/index.js";
import { corpus } from "./corpus.mjs";
import { assertConforms } from "./conformance.mjs";

const target = "bedrock/us.anthropic.claude-sonnet-5-5";
const recursive = new Set(["recursive tree", "root recursion with #"]);
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`bedrock strict: ${name} (${use})`, () => {
      if (recursive.has(name)) return assert.throws(() => convert(schema, { target, use }), /recursive/);
      const r = convert(schema, { target, use });
      assertConforms(r.schema, r.target);
    });
  }
}

test("bedrock: fields; the output schema must be sent as a JSON string", () => {
  assert.equal(convert({ type: "object" }, { target }).field, "toolConfig.tools[].toolSpec.inputSchema.json");
  assert.equal(convert({ type: "object" }, { target, use: "output" }).field, "outputConfig.textFormat.structure.jsonSchema.schema");
  assert.equal(convert({ type: "object" }, { target, strict: false }).field, "toolConfig.tools[].toolSpec.inputSchema.json");
});

test("bedrock strict: closed objects, optional fields kept, unsupported bounds described", () => {
  const r = convert({
    type: "object",
    properties: { q: { type: "string", minLength: 1, format: "uri" }, n: { type: "integer", maximum: 9 }, tags: { type: "array", items: { type: "string" }, minItems: 2 }, one: { type: "array", items: { type: "string" }, minItems: 1 } },
    required: ["q"],
  }, { target });
  const p = r.schema.properties;
  assert.equal(r.schema.additionalProperties, false);
  assert.deepEqual(r.schema.required, ["q"]);
  assert.equal(p.q.format, "uri");
  assert.equal(p.q.minLength, undefined);
  assert.equal(p.n.maximum, undefined);
  assert.equal(p.tags.minItems, undefined);
  assert.equal(p.one.minItems, 1);
});

test("bedrock strict: at most 12 optional properties", () => {
  const properties = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, { type: "string" }]));
  assert.throws(() => convert({ type: "object", properties }, { target }), /13 optional properties exceed the limit of 12/);
});

test("bedrock: Nova and Llama models need strict: false", () => {
  for (const m of ["bedrock/us.amazon.nova-pro-v1:0", "bedrock/amazon.nova-2-lite-v1:0", "bedrock/meta.llama4-maverick-17b-instruct-v1:0"]) {
    assert.throws(() => resolveTarget(m), /strict: false/, m);
    assert.equal(resolveTarget(m, { strict: false }).keywords, "any");
  }
  assert.equal(resolveTarget("bedrock/mistral.mistral-large-3").provider, "bedrock");
});

test("bedrock strict with Zod", () => {
  const s = z.object({ city: z.string(), unit: z.enum(["c", "f"]).optional(), days: z.number().int().min(1).max(7) });
  const r = convert(fromAny(s), { target });
  assertConforms(r.schema, resolveTarget(target));
  assert.equal(s.safeParse(r.decode({ city: "Pune", days: 3 })).success, true);
});
