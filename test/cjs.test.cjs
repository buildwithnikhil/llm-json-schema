const { test } = require("node:test");
const assert = require("node:assert/strict");
const { convert, fromAny, UnsupportedSchemaError } = require("../dist/index.cjs");

test("CommonJS build works", () => {
  assert.equal(typeof convert, "function");
  assert.equal(typeof fromAny, "function");
  assert.equal(typeof UnsupportedSchemaError, "function");
  const r = convert({ type: "object", properties: { a: { type: "string" } } }, { target: "openai" });
  assert.deepEqual(r.schema.required, ["a"]);
});
