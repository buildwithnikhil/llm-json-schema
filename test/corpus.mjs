// Shapes taken from the bug reports in TARGETS.md and common schema-library output.
export const corpus = {
  "langchainjs#11381 $ref with sibling keywords": {
    type: "object",
    $defs: { Unit: { type: "string", enum: ["c", "f"] } },
    properties: { a: { $ref: "#/$defs/Unit", default: "c", description: "unit A" }, b: { $ref: "#/$defs/Unit" } },
    required: ["a", "b"],
  },
  "pi#7010 object with only optional properties": {
    type: "object",
    properties: { options: { type: "object", properties: { verbose: { type: "boolean" }, depth: { type: "integer" } } } },
  },
  "composio#4750 vendor keywords": {
    type: "object",
    properties: {
      user_id: { type: "string", examples: ["me"], human_parameter_name: "User", human_parameter_description: "Who", file_uploadable: false },
      count: { type: "integer", exclusiveMinimum: 0, const: 5 },
      label: { type: ["string", "null"] },
    },
    required: ["user_id"],
  },
  "cloudflare#378 never property": { type: "object", properties: { a: { type: "string" }, legacy: { not: {} } }, required: ["a"] },
  "draft-07 definitions, tuple items and nullable": {
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: { Point: { type: "array", items: [{ type: "number" }, { type: "number" }], additionalItems: false } },
    type: "object",
    properties: { at: { $ref: "#/definitions/Point" }, note: { type: "string", nullable: true, maxLength: 20 } },
    required: ["at"],
  },
  "map, free-form object and any": {
    type: "object",
    properties: { scores: { type: "object", additionalProperties: { type: "number" } }, extra: { type: "object" }, raw: {} },
    required: ["scores", "extra", "raw"],
  },
  "patternProperties": { type: "object", patternProperties: { "^x-": { type: "string" } } },
  "multi-type and oneOf": {
    type: "object",
    properties: { id: { type: ["string", "integer"] }, shape: { oneOf: [{ type: "object", properties: { r: { type: "number" } }, required: ["r"] }, { type: "object", properties: { w: { type: "number" } }, required: ["w"] }] } },
    required: ["id", "shape"],
  },
  "allOf intersection": {
    allOf: [
      { type: "object", properties: { a: { type: "string", minLength: 2 } }, required: ["a"] },
      { type: "object", properties: { a: { type: "string", maxLength: 5 }, b: { type: "boolean" } } },
    ],
  },
  "recursive tree": {
    $defs: { Node: { type: "object", properties: { label: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/Node" } } }, required: ["label", "children"] } },
    $ref: "#/$defs/Node",
  },
  "root recursion with #": { type: "object", properties: { name: { type: "string" }, parent: { $ref: "#" } }, required: ["name"] },
  "root array": { type: "array", items: { type: "string", format: "email" } },
  "root discriminated union": { anyOf: [{ type: "object", properties: { kind: { const: "a" } }, required: ["kind"] }, { type: "object", properties: { kind: { const: "b" }, n: { type: "number" } }, required: ["kind", "n"] }] },
  "unsupported format and uniqueItems": { type: "object", properties: { site: { type: "string", format: "uri" }, tags: { type: "array", items: { type: "string" }, uniqueItems: true, minItems: 1 } }, required: ["site", "tags"] },
};
