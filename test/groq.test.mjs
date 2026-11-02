import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, resolveTarget } from "../dist/index.js";
import { corpus } from "./corpus.mjs";
import { assertConforms } from "./conformance.mjs";

const target = "groq/openai/gpt-oss-120b";
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`groq strict: ${name} (${use})`, () => {
      const r = convert(schema, { target, use });
      assertConforms(r.schema, r.target);
    });
  }
}

test("groq: model ids with slashes, fields, strict and non-strict", () => {
  const r = convert({ type: "object", properties: { a: { type: "string" } } }, { target });
  assert.equal(r.target.provider, "groq");
  assert.equal(r.field, "tools[].function.parameters");
  assert.deepEqual(r.schema.required, ["a"]); // strict: every property required (nullable)
  assert.equal(convert({ type: "object" }, { target, use: "output" }).field, "response_format.json_schema.schema");
  const loose = convert({ type: "object", properties: { a: { type: "string", minLength: 2 } } }, { target, strict: false });
  assert.deepEqual(loose.schema, { type: "object", properties: { a: { type: "string", minLength: 2 } } });
});

test("groq strict: undocumented keywords (format, pattern, bounds) move to the description", () => {
  const r = convert({ type: "object", properties: { e: { type: "string", format: "email", pattern: "^.+@.+$", maxLength: 50 } }, required: ["e"] }, { target });
  assert.deepEqual(Object.keys(r.schema.properties.e).sort(), ["description", "type"]);
  assert.match(r.schema.properties.e.description, /Format: email\./);
  assert.equal(r.check({ e: "nope" }).valid, false);
});

test("groq strict keeps recursion through $defs", () => {
  const r = convert(corpus["recursive tree"], { target });
  assert.ok(r.schema.$defs.Node);
  assertConforms(r.schema, resolveTarget(target));
});
