import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, resolveTarget } from "../dist/index.js";
import { corpus } from "./corpus.mjs";
import { assertConforms } from "./conformance.mjs";

const recursive = new Set(["recursive tree", "root recursion with #"]);
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`ollama ${use === "tool" ? "tools" : "format"}: ${name}`, () => {
      if (recursive.has(name)) return assert.throws(() => convert(schema, { target: "ollama/gpt-oss", use }), /recursive/);
      const r = convert(schema, { target: "ollama/gpt-oss", use });
      assertConforms(r.schema, r.target);
    });
  }
}

test("ollama picks different rules for tools and for format", () => {
  assert.ok(!resolveTarget("ollama", { use: "tool" }).keywords.includes("pattern"));
  assert.ok(resolveTarget("ollama", { use: "output" }).keywords.includes("pattern"));
  assert.equal(convert({ type: "object" }, { target: "ollama" }).field, "tools[].function.parameters");
  assert.equal(convert({ type: "object" }, { target: "ollama", use: "output" }).field, "format");
});

test("ollama tools: keywords Ollama would drop silently are moved to the description instead", () => {
  const r = convert({ type: "object", properties: { email: { type: "string", format: "email", pattern: "^.+@.+$", default: "a@b.co" }, n: { type: "integer", minimum: 1, const: 3 } }, required: ["email"] }, { target: "ollama" });
  const p = r.schema.properties;
  assert.deepEqual(Object.keys(p.email).sort(), ["description", "type"]);
  assert.match(p.email.description, /Format: email\. Must match the regular expression "\^\.\+@\.\+\$"\. Default: "a@b\.co"\./);
  assert.deepEqual(p.n.enum, [3]);
  assert.match(p.n.description, /Minimum 1\./);
});

test("ollama format: patterns are anchored, numeric bounds and prefixItems are avoided, objects are explicit", () => {
  const r = convert({
    type: "object",
    properties: {
      code: { type: "string", pattern: "[A-Z]{3}" },
      when: { type: "string", format: "date-time" },
      score: { type: "number", minimum: 0, maximum: 1 },
      pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] },
      meta: { type: "object" },
    },
    required: ["code"],
  }, { target: "ollama", use: "output" });
  const p = r.schema.properties;
  assert.equal(p.code.pattern, "^.*(?:[A-Z]{3}).*$");
  assert.equal(p.when.format, "date-time");
  assert.equal(p.score.minimum, undefined);
  assert.match(p.score.description, /Minimum 0\. Maximum 1\./);
  assert.equal(p.pair.type, "object"); // tuple sent as {"0": …, "1": …}
  assert.deepEqual(p.meta, { type: "object", additionalProperties: true });
  assert.deepEqual(r.decode({ code: "xABCx", pair: { 0: "a", 1: 2 } }), { code: "xABCx", pair: ["a", 2] });
  assert.equal(r.check({ code: "abc", score: 2 }).errors.length, 2);
});
