import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { convert, fromAny, resolveTarget } from "../dist/index.js";
import { corpus } from "./corpus.mjs";

const OPENAPI_TYPES = new Set(["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT", "NULL"]);

/** Throws unless `schema` uses only what Gemini's OpenAPI `Schema` message defines. */
function assertGeminiOpenApi(schema) {
  const caps = resolveTarget("google-openapi");
  const allowed = new Set([...caps.keywords, "nullable"]);
  const walk = (s, at, isRoot) => {
    for (const k of Object.keys(s)) assert.ok(allowed.has(k), `${at}: "${k}" isn't a field of Gemini's Schema`);
    if (s.anyOf) return s.anyOf.forEach((b, i) => walk(b, `${at}/anyOf/${i}`, false));
    assert.equal(typeof s.type, "string", `${at}: type must be a single name`);
    assert.ok(OPENAPI_TYPES.has(s.type), `${at}: type ${s.type} must be upper-case`);
    if (isRoot) assert.equal(s.type, "OBJECT");
    if (s.enum) assert.ok(s.enum.every((v) => typeof v === "string"), `${at}: enum must be strings`);
    for (const [k, c] of Object.entries(s.properties ?? {})) walk(c, `${at}/properties/${k}`, false);
    if (s.items) walk(s.items, `${at}/items`, false);
  };
  walk(schema, "#", true);
}

const recursive = new Set(["recursive tree", "root recursion with #"]);
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`google-openapi: ${name} (${use})`, () => {
      if (recursive.has(name)) return assert.throws(() => convert(schema, { target: "google-openapi", use }), /recursive/);
      assertGeminiOpenApi(convert(schema, { target: "google-openapi", use }).schema);
    });
    test(`google (JSON Schema fields): ${name} (${use}) is sent as written`, () => {
      const r = convert(schema, { target: "gemini/gemini-3.5-flash-lite", use });
      if (name.startsWith("draft-07")) return; // covered by the draft-07 test below
      const { $schema, ...expected } = structuredClone(schema);
      assert.deepEqual(r.schema, expected);
      assert.deepEqual(r.losses, []);
    });
  }
}

test("fields per dialect", () => {
  assert.equal(convert({ type: "object" }, { target: "google" }).field, "tools[].functionDeclarations[].parametersJsonSchema");
  assert.equal(convert({ type: "object" }, { target: "google", use: "output" }).field, "generationConfig.responseJsonSchema");
  assert.equal(convert({ type: "object" }, { target: "google-openapi" }).field, "tools[].functionDeclarations[].parameters");
  assert.equal(convert({ type: "object" }, { target: "vertex" }).field, "tools[].functionDeclarations[].parameters");
});

test("google-openapi: Composio's keywords (composio#4750) become valid Schema fields", () => {
  const r = convert(
    {
      type: "object",
      properties: {
        user_id: { type: "string", examples: ["me"], human_parameter_name: "User", file_uploadable: false },
        count: { type: "integer", enum: [1, 2, 3], exclusiveMinimum: 0 },
        mode: { const: "fast" },
        label: { type: ["string", "null"] },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
    { target: "google-openapi" },
  );
  assert.deepEqual(r.schema, {
    type: "OBJECT",
    properties: {
      user_id: { type: "STRING", description: 'Example: "me".' },
      count: { type: "INTEGER", description: "One of: 1, 2, 3. Greater than 0." },
      mode: { type: "STRING", enum: ["fast"] },
      label: { type: "STRING", nullable: true },
    },
    required: ["user_id"],
  });
  assert.equal(r.check({ user_id: "x", count: 4, extra: 1 }).errors.length, 2); // enum and additionalProperties still enforced
  assert.deepEqual(r.decode({ user_id: "x", label: null }), { user_id: "x", label: null });
});

test("google-openapi: maps become entries, $ref is inlined, unions keep upper-case types", () => {
  const r = convert({ type: "object", $defs: { Tag: { type: "string" } }, properties: { tags: { type: "object", additionalProperties: { $ref: "#/$defs/Tag" } }, v: { anyOf: [{ type: "string" }, { type: "number" }] } }, required: ["tags", "v"] }, { target: "google-openapi" });
  assert.equal(r.schema.properties.tags.type, "ARRAY");
  assert.deepEqual(r.schema.properties.tags.items.properties.value, { type: "STRING" });
  assert.deepEqual(r.schema.properties.v, { anyOf: [{ type: "STRING" }, { type: "NUMBER" }] });
  assert.deepEqual(r.decode({ tags: [{ key: "a", value: "b" }], v: 1 }), { tags: { a: "b" }, v: 1 });
});

test("google (JSON Schema fields): keeps maps, tuples, optional fields and oneOf (probed 2026-11-02)", () => {
  const s = { type: "object", properties: { scores: { type: "object", additionalProperties: { type: "number" } }, at: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] }, n: { type: ["integer", "null"] } }, required: ["scores"] };
  const r = convert(s, { target: "google" });
  assert.deepEqual(r.schema.properties.scores, s.properties.scores);
  assert.deepEqual(r.schema.properties.at.prefixItems, s.properties.at.prefixItems);
  assert.deepEqual(r.schema.required, ["scores"]);
  assert.deepEqual(r.decode({ scores: { a: 1 }, at: [1, 2] }), { scores: { a: 1 }, at: [1, 2] });
  const u = convert({ type: "object", properties: { x: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["x"] }, { target: "google" });
  assert.ok(u.schema.properties.x.oneOf);
  assert.deepEqual(u.losses, []);
  assert.equal(u.check({ x: true }).valid, false); // check() still enforces the original
});

test("Gemini with Zod (zod#5807: anyOf from toJSONSchema)", () => {
  const s = z.object({ id: z.union([z.string(), z.number()]), when: z.iso.datetime().optional(), kind: z.enum(["a", "b"]) });
  for (const target of ["google", "google-openapi"]) {
    const r = convert(fromAny(s), { target });
    if (target === "google-openapi") assertGeminiOpenApi(r.schema);
    assert.equal(s.safeParse(r.decode({ id: 1, kind: "a" })).success, true);
  }
});

test("google (JSON Schema fields): draft-07 spellings become 2020-12 (live probe: array items were rejected)", () => {
  const r = convert(corpus["draft-07 definitions, tuple items and nullable"], { target: "google" });
  assert.deepEqual(r.schema.$defs.Point, { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false });
  assert.equal(r.schema.definitions, undefined);
  assert.deepEqual(r.schema.properties.at, { $ref: "#/$defs/Point" });
  assert.deepEqual(r.schema.properties.note.type, ["string", "null"]);
  assert.equal(r.losses.length, 1);
  assert.equal(r.losses[0].action, "rewritten");
});
