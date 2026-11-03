import { test } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../dist/index.js";
import { corpus } from "./corpus.mjs";

test("mistral: schemas are sent as written (Mistral documents no schema rules), strict or not", () => {
  const s = { type: "object", properties: { a: { type: "string", minLength: 2, format: "email" }, b: { oneOf: [{ type: "integer" }, { type: "null" }] } }, required: ["a"] };
  for (const strict of [true, false]) {
    const r = convert(s, { target: "mistral/mistral-large-latest", strict });
    assert.deepEqual(r.schema, s);
    assert.deepEqual(r.losses, []);
  }
});

test("mistral: fields and the object root for tools", () => {
  assert.equal(convert({ type: "object" }, { target: "mistral" }).field, "tools[].function.parameters");
  assert.equal(convert({ type: "object" }, { target: "mistral", use: "output" }).field, "response_format.json_schema.schema");
  const r = convert(corpus["root array"], { target: "mistral" });
  assert.equal(r.schema.type, "object");
  assert.deepEqual(r.decode({ value: ["a@b.co"] }), ["a@b.co"]);
});
