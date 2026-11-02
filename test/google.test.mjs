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

/** Throws unless `schema` uses only the keywords documented for Gemini's JSON Schema fields. */
function assertGeminiJson(schema) {
  const caps = resolveTarget("google");
  const allowed = new Set(caps.keywords);
  const walk = (s, at) => {
    for (const k of Object.keys(s)) assert.ok(allowed.has(k), `${at}: keyword "${k}" isn't documented for Gemini`);
    if (s.$ref) return assert.deepEqual(Object.keys(s), ["$ref"]);
    if (s.format !== undefined) assert.ok(caps.formats.includes(s.format), `${at}: format ${s.format}`);
    for (const [k, c] of Object.entries(s.properties ?? {})) walk(c, `${at}/properties/${k}`);
    if (s.items) walk(s.items, `${at}/items`);
    if (s.prefixItems) s.prefixItems.forEach((c, i) => walk(c, `${at}/prefixItems/${i}`));
    if (typeof s.additionalProperties === "object") walk(s.additionalProperties, `${at}/additionalProperties`);
    if (s.anyOf) s.anyOf.forEach((b, i) => walk(b, `${at}/anyOf/${i}`));
  };
  walk(schema, "#");
}

const recursive = new Set(["recursive tree", "root recursion with #"]);
for (const [name, schema] of Object.entries(corpus)) {
  for (const use of ["tool", "output"]) {
    test(`google-openapi: ${name} (${use})`, () => {
      if (recursive.has(name)) return assert.throws(() => convert(schema, { target: "google-openapi", use }), /recursive/);
      assertGeminiOpenApi(convert(schema, { target: "google-openapi", use }).schema);
    });
    test(`google (JSON Schema fields): ${name} (${use})`, () => {
      if (recursive.has(name)) return assert.throws(() => convert(schema, { target: "gemini/gemini-2.5-flash", use }), /recursive/);
      assertGeminiJson(convert(schema, { target: "gemini/gemini-2.5-flash", use }).schema);
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

test("google (JSON Schema fields): keeps maps, tuples and optional fields; rewrites oneOf and $ref siblings", () => {
  const s = { type: "object", properties: { scores: { type: "object", additionalProperties: { type: "number" } }, at: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] }, n: { type: ["integer", "null"] } }, required: ["scores"] };
  const r = convert(s, { target: "google" });
  assert.deepEqual(r.schema.properties.scores, s.properties.scores);
  assert.deepEqual(r.schema.properties.at.prefixItems, s.properties.at.prefixItems);
  assert.deepEqual(r.schema.required, ["scores"]);
  assert.deepEqual(r.decode({ scores: { a: 1 }, at: [1, 2] }), { scores: { a: 1 }, at: [1, 2] });
  const u = convert({ type: "object", properties: { x: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["x"] }, { target: "google" });
  assert.ok(u.schema.properties.x.anyOf);
  assert.equal(u.losses[0].action, "relaxed");
});

test("Gemini with Zod (zod#5807: anyOf from toJSONSchema)", () => {
  const s = z.object({ id: z.union([z.string(), z.number()]), when: z.iso.datetime().optional(), kind: z.enum(["a", "b"]) });
  for (const target of ["google", "google-openapi"]) {
    const r = convert(fromAny(s), { target });
    (target === "google" ? assertGeminiJson : assertGeminiOpenApi)(r.schema);
    assert.equal(s.safeParse(r.decode({ id: 1, kind: "a" })).success, true);
  }
});
