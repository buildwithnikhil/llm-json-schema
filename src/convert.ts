import { UnsupportedSchemaError } from "./errors.js";
import { flattenAllOf, mergeTwo } from "./merge.js";
import { dereference, esc, has, isObj, normalize, resolvePointer } from "./refs.js";
import { resolveTarget } from "./targets.js";
import type { Capabilities, ConvertOptions, ConvertResult, JSONSchema, Loss, LossAction, SchemaObject } from "./types.js";
import { deepEqual, matches, validate } from "./validate.js";

type Decoder = (value: unknown) => unknown;
interface Node {
  schema: SchemaObject;
  decode?: Decoder;
}

interface Ctx {
  caps: Capabilities;
  allow: { has(keyword: string): boolean };
  losses: Loss[];
  /** Decoders for kept recursive `$defs`, filled in before any decode runs. */
  defDecoders: Map<string, Decoder | undefined>;
  /** The final schema, for resolving `$ref`s while choosing an anyOf branch during decode. */
  final?: SchemaObject;
}

/** Keywords handled structurally by `node()`; everything else goes through `filterKeywords()`. */
const STRUCTURAL = new Set([
  "type", "properties", "required", "additionalProperties", "patternProperties", "items", "prefixItems",
  "anyOf", "oneOf", "allOf", "enum", "$ref", "$defs", "description",
  "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "propertyNames", "contains", "minContains", "maxContains",
]);
/** Removing these loses nothing the data has to satisfy. */
const ANNOTATION = new Set(["title", "default", "examples", "deprecated", "readOnly", "writeOnly", "$anchor", "$dynamicAnchor", "contentMediaType", "contentEncoding"]);
const NULL: SchemaObject = { type: "null" };

const loss = (ctx: Ctx, path: string, keyword: string, value: unknown, action: LossAction, note: string) =>
  void ctx.losses.push(value === undefined ? { path, keyword, action, note } : { path, keyword, value, action, note });

const typesOf = (s: SchemaObject): string[] => (s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
const isNever = (s: unknown) => isObj(s) && Object.keys(s).length === 1 && isObj(s.not) && Object.keys(s.not).length === 0;

/** A sentence restating a removed constraint, so the model still sees it. */
function sentence(k: string, v: unknown): string {
  const n = JSON.stringify(v);
  switch (k) {
    case "minLength": return `At least ${n} characters.`;
    case "maxLength": return `At most ${n} characters.`;
    case "pattern": return `Must match the regular expression ${n}.`;
    case "format": return `Format: ${v}.`;
    case "minimum": return `Minimum ${n}.`;
    case "maximum": return `Maximum ${n}.`;
    case "exclusiveMinimum": return `Greater than ${n}.`;
    case "exclusiveMaximum": return `Less than ${n}.`;
    case "multipleOf": return `A multiple of ${n}.`;
    case "minItems": return `At least ${n} items.`;
    case "maxItems": return `At most ${n} items.`;
    case "uniqueItems": return v === true ? "Items must be unique." : "";
    case "minProperties": return `At least ${n} properties.`;
    case "maxProperties": return `At most ${n} properties.`;
    case "default": return `Default: ${n}.`;
    case "examples": return Array.isArray(v) && v.length ? `Example${v.length > 1 ? "s" : ""}: ${v.map((x) => JSON.stringify(x)).join(", ")}.` : "";
    default: return `${k}: ${n}.`;
  }
}

function describe(s: SchemaObject, ctx: Ctx, extra: string[]): void {
  const text = extra.filter(Boolean);
  if (text.length === 0 || !ctx.allow.has("description")) return;
  s.description = [typeof s.description === "string" ? s.description : "", ...text].filter(Boolean).join(" ");
}

/** Removes keywords the target doesn't accept, restating constraints in the description. */
function filterKeywords(src: SchemaObject, out: SchemaObject, path: string, ctx: Ctx): void {
  const notes: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (STRUCTURAL.has(k)) continue;
    let allowed = ctx.allow.has(k);
    if (allowed && k === "format" && ctx.caps.formats !== "any" && !ctx.caps.formats.includes(String(v))) allowed = false;
    if (allowed && ctx.caps.rules?.[k] && !ctx.caps.rules[k]!(v)) allowed = false;
    if (allowed) {
      out[k] = v;
      continue;
    }
    if (k === "default" || k === "examples") {
      const text = sentence(k, v);
      notes.push(text);
      loss(ctx, path, k, v, ctx.allow.has("description") && text ? "described" : "dropped", `${k} isn't accepted; ${ctx.allow.has("description") ? "moved into the description" : "removed"}`);
    } else if (ANNOTATION.has(k) || k.startsWith("x-")) {
      loss(ctx, path, k, v, "dropped", `annotation ${k} isn't accepted`);
    } else if (sentence(k, v).startsWith(`${k}:`) && !isKnownAssertion(k)) {
      loss(ctx, path, k, v, "dropped", `unknown keyword ${k} isn't accepted`);
    } else {
      notes.push(sentence(k, v));
      loss(ctx, path, k, v, ctx.allow.has("description") ? "described" : "dropped", `${k} isn't enforced by ${ctx.caps.id}; ${ctx.allow.has("description") ? "stated in the description and " : ""}enforced by check()`);
    }
  }
  describe(out, ctx, notes);
}

const ASSERTIONS = new Set(["minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "unevaluatedProperties", "unevaluatedItems"]);
const isKnownAssertion = (k: string) => ASSERTIONS.has(k);

function acceptsNull(s: SchemaObject): boolean {
  if (typesOf(s).includes("null")) return true;
  if (Array.isArray(s.anyOf)) return s.anyOf.some((b) => isObj(b) && acceptsNull(b as SchemaObject));
  if (Array.isArray(s.enum)) return s.enum.includes(null);
  return false;
}

function addNull(s: SchemaObject, ctx: Ctx): SchemaObject {
  if (acceptsNull(s)) return s;
  if (Array.isArray(s.anyOf)) return { ...s, anyOf: [...s.anyOf, NULL] };
  const types = typesOf(s);
  if (ctx.caps.typeArrays && types.length > 0 && s.$ref === undefined) {
    const out = { ...s, type: [...types, "null"] };
    if (Array.isArray(out.enum)) out.enum = [...out.enum, null];
    return out;
  }
  const { description, ...rest } = s;
  return description !== undefined ? { description, anyOf: [rest, NULL] } : { anyOf: [rest, NULL] };
}

function inferTypeFromEnum(values: unknown[]): string[] {
  const t = new Set<string>();
  for (const v of values) t.add(v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v === "number" ? "number" : typeof v);
  if (t.has("integer") && t.has("number")) t.delete("integer");
  return [...t];
}

function inferType(values: unknown[]): string | string[] {
  const t = inferTypeFromEnum(values);
  return t.length === 1 ? t[0]! : t;
}

function node(input: SchemaObject, path: string, ctx: Ctx): Node {
  let s: SchemaObject = { ...input };
  const { caps, allow } = ctx;

  // allOf: fold into one schema.
  if (Array.isArray(s.allOf)) {
    if (allow.has("allOf")) {
      const parts = s.allOf.map((p, i) => node(p as SchemaObject, `${path}/allOf/${i}`, ctx).schema);
      const { allOf: _, ...rest } = s;
      const base = node(rest, path, ctx);
      return { schema: { ...base.schema, allOf: parts }, decode: base.decode };
    }
    const flat = flattenAllOf(s);
    if (!flat) {
      throw new UnsupportedSchemaError(path, caps.id, "allOf with parts that can't be combined into one schema", "Rewrite it as a single schema or an anyOf");
    }
    loss(ctx, path, "allOf", undefined, "rewritten", "allOf merged into a single schema");
    s = flat;
  }

  // A kept recursive reference.
  if (typeof s.$ref === "string") {
    const { $ref, ...siblings } = s;
    const name = $ref.replace(/^#\/\$defs\//, "");
    if (Object.keys(siblings).length > 0 && !caps.refSiblings) {
      for (const k of Object.keys(siblings)) loss(ctx, path, k, siblings[k], "dropped", `keywords next to a recursive $ref aren't accepted by ${caps.id}`);
    }
    const ref: SchemaObject = caps.refSiblings ? { ...siblings, $ref } : { $ref };
    return { schema: ref, decode: (v) => (ctx.defDecoders.get(name) ?? ((x: unknown) => x))(v) };
  }

  const rule = (k: string, v: unknown) => !caps.rules?.[k] || caps.rules[k]!(v);
  if (has(s, "const") && (!allow.has("const") || !rule("const", s.const))) {
    loss(ctx, path, "const", s.const, "rewritten", "const written as a one-value enum");
    s.enum = [s.const];
    delete s.const;
  }
  if (Array.isArray(s.enum) && s.type === undefined) s.type = inferType(s.enum);
  if (Array.isArray(s.enum) && !rule("enum", s.enum)) {
    loss(ctx, path, "enum", s.enum, "relaxed", `enum values ${caps.id} doesn't accept; listed in the description and enforced by check()`);
    describe(s, ctx, [`One of: ${s.enum.map((e) => JSON.stringify(e)).join(", ")}.`]);
    delete s.enum;
  }
  if (has(s, "const") && s.type === undefined) s.type = inferType([s.const]);

  if (Array.isArray(s.oneOf)) {
    if (!allow.has("oneOf")) {
      loss(ctx, path, "oneOf", undefined, "relaxed", "oneOf sent as anyOf; check() enforces that exactly one matches");
      s.anyOf = Array.isArray(s.anyOf) ? [{ anyOf: s.anyOf }, { anyOf: s.oneOf }] : s.oneOf;
      delete s.oneOf;
    }
  }

  // Several non-null types: split into a union so each branch can carry its own keywords.
  const types = typesOf(s);
  const nonNull = types.filter((t) => t !== "null");
  if (nonNull.length > 1 && !Array.isArray(s.anyOf)) {
    const { type: _, description, ...rest } = s;
    const branches = nonNull.map((t) => ({ ...rest, type: t }));
    if (types.includes("null")) branches.push({ type: "null" } as typeof branches[number]);
    s = description !== undefined ? { description, anyOf: branches } : { anyOf: branches };
    loss(ctx, path, "type", types, "rewritten", "multiple types written as anyOf");
  }

  // Conditional and negative keywords.
  for (const k of ["not", "if", "then", "else", "dependentRequired", "dependentSchemas", "propertyNames", "contains", "minContains", "maxContains"]) {
    if (!has(s, k)) continue;
    if (allow.has(k)) continue;
    loss(ctx, path, k, s[k], "dropped", `${k} isn't accepted by ${caps.id}; check() enforces it`);
    delete s[k];
  }

  if (Array.isArray(s.anyOf)) return union(s, path, ctx);

  const t = typesOf(s).filter((x) => x !== "null");
  const nullable = typesOf(s).includes("null");
  let kind = t[0];
  if (kind === undefined) {
    if (isObj(s.properties) || isObj(s.patternProperties) || has(s, "additionalProperties")) kind = "object";
    else if (has(s, "items") || Array.isArray(s.prefixItems)) kind = "array";
    else if (typesOf(s).length === 1 && nullable) kind = "null";
  }
  let result: Node;
  if (kind === "object") result = object(s, path, ctx);
  else if (kind === "array") result = array(s, path, ctx);
  else if (kind === undefined) result = anything(s, path, ctx);
  else {
    const out: SchemaObject = { type: s.type };
    if (Array.isArray(s.enum)) out.enum = s.enum;
    if (typeof s.description === "string" && allow.has("description")) out.description = s.description;
    filterKeywords(s, out, path, ctx);
    result = { schema: out };
  }
  if (nullable && !acceptsNull(result.schema)) {
    result = { schema: addNull(result.schema, ctx), decode: result.decode && ((v) => (v === null ? null : result.decode!(v))) };
  }
  return result;
}

function union(s: SchemaObject, path: string, ctx: Ctx): Node {
  const { anyOf, ...rest } = s;
  const { description: _d, title: _t, ...struct } = rest;
  const hasStructure = Object.keys(struct).length > 0;
  let branches = anyOf as SchemaObject[];
  if (hasStructure) {
    // Keywords beside anyOf apply to every branch: move them in.
    const merged = mergeTwo(struct, { anyOf: branches });
    if (!merged || !Array.isArray(merged.anyOf)) throw new UnsupportedSchemaError(path, ctx.caps.id, "anyOf with sibling keywords that conflict with its branches");
    branches = merged.anyOf as SchemaObject[];
  }
  // Flatten nested unions.
  branches = branches.flatMap((b) => (Array.isArray(b.anyOf) && Object.keys(b).length === 1 ? (b.anyOf as SchemaObject[]) : [b]));
  const nodes = branches.map((b, i) => node(b, `${path}/anyOf/${i}`, ctx));
  const out: SchemaObject = { anyOf: nodes.map((n) => n.schema) };
  if (typeof s.description === "string" && ctx.allow.has("description")) out.description = s.description;
  for (const k of Object.keys(rest)) if (k !== "description" && !hasStructure) filterKeywords({ [k]: rest[k] }, out, path, ctx);
  if (!nodes.some((n) => n.decode)) return { schema: out };
  return {
    schema: out,
    decode: (v) => {
      const i = nodes.findIndex((n) => matches(v, n.schema, ctx.final));
      const d = i === -1 ? undefined : nodes[i]!.decode;
      return d ? d(v) : v;
    },
  };
}

function object(s: SchemaObject, path: string, ctx: Ctx): Node {
  const { caps, allow } = ctx;
  const props = (isObj(s.properties) ? s.properties : {}) as Record<string, SchemaObject>;
  const patterns = (isObj(s.patternProperties) ? s.patternProperties : {}) as Record<string, SchemaObject>;
  const extra = s.additionalProperties;
  const declared = Object.keys(props).filter((k) => !isNever(props[k]));
  const mapValue = isObj(extra) && Object.keys(extra).length > 0 ? (extra as SchemaObject) : undefined;

  for (const k of Object.keys(props)) if (isNever(props[k])) loss(ctx, `${path}/properties/${esc(k)}`, "not", {}, "rewritten", "a property that can never be present was removed");

  // No listed properties: a map or a free-form object.
  if (declared.length === 0 && (mapValue || Object.keys(patterns).length > 0) && !(allow.has("additionalProperties") && !caps.closedObjects)) {
    const patternList = Object.entries(patterns);
    const valueSchema: SchemaObject =
      patternList.length === 0 ? mapValue! : patternList.length === 1 && !mapValue ? patternList[0]![1] : { anyOf: [...patternList.map(([, p]) => p), ...(mapValue ? [mapValue] : [])] };
    const keySchema: SchemaObject = { type: "string" };
    if (patternList.length > 0 && !mapValue) keySchema.pattern = patternList.length === 1 ? patternList[0]![0] : patternList.map(([p]) => `(?:${p})`).join("|");
    if (isObj(s.propertyNames)) Object.assign(keySchema, s.propertyNames);
    const entry: SchemaObject = { type: "object", properties: { key: keySchema, value: valueSchema }, required: ["key", "value"] };
    loss(ctx, path, patternList.length ? "patternProperties" : "additionalProperties", undefined, "restructured", "map sent as an array of {key, value} entries; decode() turns it back into an object");
    const arr = node({ type: "array", items: entry, ...(typeof s.description === "string" ? { description: s.description } : {}) }, path, ctx);
    const inner = arr.decode;
    return {
      schema: arr.schema,
      decode: (v) => {
        const list = inner ? inner(v) : v;
        if (!Array.isArray(list)) return list;
        const out: Record<string, unknown> = {};
        for (const e of list) if (isObj(e) && typeof e.key === "string") out[e.key] = e.value;
        return out;
      },
    };
  }
  if (declared.length === 0 && !caps.openSchemas) return anything(s, path, ctx, "object");

  const out: SchemaObject = { type: "object" };
  if (typeof s.description === "string" && allow.has("description")) out.description = s.description;
  const required = new Set((Array.isArray(s.required) ? s.required : []).filter((k) => declared.includes(k)));
  const outProps: Record<string, SchemaObject> = {};
  const decoders: Record<string, Decoder> = {};
  const nullToAbsent = new Set<string>();
  for (const k of declared) {
    const p = `${path}/properties/${esc(k)}`;
    const child = node(props[k]!, p, ctx);
    let schema = child.schema;
    if (caps.allRequired && !required.has(k)) {
      if (acceptsNull(schema)) {
        loss(ctx, p, "required", false, "relaxed", "optional field made required; it already allows null, so decode() keeps null rather than removing the field");
      } else {
        schema = addNull(schema, ctx);
        nullToAbsent.add(k);
        loss(ctx, p, "required", false, "restructured", "optional field made required and nullable; decode() removes it when null");
      }
    }
    outProps[k] = schema;
    if (child.decode) decoders[k] = child.decode;
  }
  out.properties = outProps;
  const req = caps.allRequired ? declared : declared.filter((k) => required.has(k));
  if (req.length > 0 || caps.allRequired) out.required = req;

  if (caps.closedObjects) {
    if (mapValue || extra === true || extra === undefined || Object.keys(patterns).length > 0) {
      if (mapValue || Object.keys(patterns).length > 0) loss(ctx, path, mapValue ? "additionalProperties" : "patternProperties", mapValue ?? patterns, "dropped", `extra keys aren't accepted by ${caps.id} next to listed properties`);
    }
    out.additionalProperties = false;
  } else if (has(s, "additionalProperties")) {
    out.additionalProperties = isObj(extra) ? node(extra as SchemaObject, `${path}/additionalProperties`, ctx).schema : extra;
  }
  filterKeywords(s, out, path, ctx);

  if (Object.keys(decoders).length === 0 && nullToAbsent.size === 0) return { schema: out };
  return {
    schema: out,
    decode: (v) => {
      if (!isObj(v)) return v;
      const r: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === null && nullToAbsent.has(k)) continue;
        r[k] = decoders[k] && x !== null ? decoders[k]!(x) : x;
      }
      return r;
    },
  };
}

function array(s: SchemaObject, path: string, ctx: Ctx): Node {
  const { allow } = ctx;
  const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as SchemaObject[]) : [];
  if (prefix.length > 0 && !allow.has("prefixItems")) {
    const rest = s.items;
    if (rest === undefined || rest === false || isNever(rest)) {
      // A fixed tuple: send it as an object with keys "0", "1", ...
      const { prefixItems: _, items: __, minItems, maxItems, ...others } = s;
      const properties = Object.fromEntries(prefix.map((p, i) => [String(i), p]));
      const min = typeof minItems === "number" ? minItems : prefix.length;
      const obj = node({ ...others, type: "object", properties, required: prefix.slice(0, min).map((_, i) => String(i)) }, path, ctx);
      loss(ctx, path, "prefixItems", undefined, "restructured", "tuple sent as an object with keys \"0\", \"1\", ...; decode() turns it back into an array");
      return {
        schema: obj.schema,
        decode: (v) => {
          const o = obj.decode ? obj.decode(v) : v;
          if (!isObj(o)) return o;
          const out: unknown[] = [];
          for (let i = 0; i < prefix.length && has(o, String(i)); i++) out.push(o[String(i)]);
          return out;
        },
      };
    }
    loss(ctx, path, "prefixItems", undefined, "relaxed", "tuple positions sent as one item type that allows any of them; check() enforces positions");
    s = { ...s, items: { anyOf: [...prefix, rest as SchemaObject] } };
    delete s.prefixItems;
  }
  const out: SchemaObject = { type: "array" };
  if (typeof s.description === "string" && allow.has("description")) out.description = s.description;
  let decode: Decoder | undefined;
  if (prefix.length > 0 && allow.has("prefixItems")) {
    const nodes = prefix.map((p, i) => node(p, `${path}/prefixItems/${i}`, ctx));
    out.prefixItems = nodes.map((n) => n.schema);
    if (isObj(s.items)) out.items = node(s.items as SchemaObject, `${path}/items`, ctx).schema;
  } else {
    const item = node(isObj(s.items) ? (s.items as SchemaObject) : s.items === false ? { not: {} } : {}, `${path}/items`, ctx);
    out.items = item.schema;
    if (item.decode) decode = (v) => (Array.isArray(v) ? v.map(item.decode!) : v);
  }
  filterKeywords(s, out, path, ctx);
  return { schema: out, decode };
}

/** A value with no fixed shape. Targets that need a shape get a JSON-encoded string. */
function anything(s: SchemaObject, path: string, ctx: Ctx, kind?: "object"): Node {
  if (ctx.caps.openSchemas) {
    const out: SchemaObject = kind ? { type: "object" } : {};
    if (typeof s.description === "string" && ctx.allow.has("description")) out.description = s.description;
    filterKeywords(s, out, path, ctx);
    return { schema: out };
  }
  const out: SchemaObject = { type: "string" };
  if (typeof s.description === "string" && ctx.allow.has("description")) out.description = s.description;
  describe(out, ctx, [kind === "object" ? "A JSON-encoded object." : "A JSON-encoded value."]);
  loss(ctx, path, "type", kind ?? "any", "restructured", `${kind === "object" ? "free-form object" : "value with no fixed type"} sent as a JSON-encoded string; decode() parses it`);
  const { additionalProperties: _, properties: __, ...rest } = s;
  filterKeywords(rest, {}, path, { ...ctx, losses: [] }); // constraints on an opaque value: enforced by check() only
  return {
    schema: out,
    decode: (v) => {
      if (typeof v !== "string") return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    },
  };
}

function measure(s: SchemaObject, caps: Capabilities, path: string): void {
  let properties = 0;
  let enums = 0;
  let optional = 0;
  let unions = 0;
  const walk = (x: unknown, depth: number, at: string) => {
    if (!isObj(x)) return;
    if (caps.limits.maxDepth !== undefined && depth > caps.limits.maxDepth) {
      throw new UnsupportedSchemaError(at, caps.id, `nesting is deeper than the limit of ${caps.limits.maxDepth} levels`, "Flatten the schema, or send deep parts as JSON-encoded strings");
    }
    if (Array.isArray(x.enum)) enums += x.enum.length;
    if (isObj(x.properties)) {
      const req = new Set(Array.isArray(x.required) ? (x.required as string[]) : []);
      for (const [k, c] of Object.entries(x.properties)) {
        properties++;
        if (!req.has(k)) optional++;
        if (isObj(c) && (Array.isArray(c.anyOf) || (Array.isArray(c.type) && c.type.length > 1))) unions++;
        walk(c, depth + 1, `${at}/properties/${esc(k)}`);
      }
    }
    if (isObj(x.items)) walk(x.items, depth + 1, `${at}/items`);
    if (Array.isArray(x.anyOf)) x.anyOf.forEach((b, i) => walk(b, depth, `${at}/anyOf/${i}`));
    if (isObj(x.$defs)) for (const [k, d] of Object.entries(x.$defs)) walk(d, 1, `${at}/$defs/${esc(k)}`);
  };
  walk(s, 1, path);
  if (caps.limits.maxProperties !== undefined && properties > caps.limits.maxProperties) {
    throw new UnsupportedSchemaError(path, caps.id, `${properties} properties exceed the limit of ${caps.limits.maxProperties}`, "Split the tool into smaller tools");
  }
  if (caps.limits.maxOptionalProperties !== undefined && optional > caps.limits.maxOptionalProperties) {
    throw new UnsupportedSchemaError(path, caps.id, `${optional} optional properties exceed the limit of ${caps.limits.maxOptionalProperties}`, "Make some fields required, or split the tool");
  }
  if (caps.limits.maxUnionProperties !== undefined && unions > caps.limits.maxUnionProperties) {
    throw new UnsupportedSchemaError(path, caps.id, `${unions} union-typed properties exceed the limit of ${caps.limits.maxUnionProperties}`, "Replace some unions or nullable fields with plain types, or split the tool");
  }
  if (caps.limits.maxEnumValues !== undefined && enums > caps.limits.maxEnumValues) {
    throw new UnsupportedSchemaError(path, caps.id, `${enums} enum values exceed the limit of ${caps.limits.maxEnumValues}`, "Replace large enums with a string and validate afterwards");
  }
}

/** Rewrites `schema` into the form `options.target` accepts. */
export function convert(schema: JSONSchema, options: ConvertOptions): ConvertResult {
  if (!options || options.target === undefined) throw new TypeError("convert(schema, { target }) needs a target, e.g. \"openai\"");
  const caps = resolveTarget(options.target, { strict: options.strict });
  const use = options.use ?? "tool";
  if (use !== "tool" && use !== "output") throw new TypeError(`use must be "tool" or "output", got ${JSON.stringify(use)}`);

  if (caps.keywords === "any") return looseConvert(schema, caps, use);
  const original = normalize(schema);
  const { root, defs, defPaths } = dereference(original, caps.id);
  const defNames = Object.keys(defs);
  if (defNames.length > 0 && !(caps.refs && caps.recursion)) {
    throw new UnsupportedSchemaError(defPaths[defNames[0]!]!, caps.id, "recursive schemas aren't accepted", "Limit the depth by writing out a fixed number of levels");
  }

  const ctx: Ctx = { caps, allow: new Set(caps.keywords), losses: [], defDecoders: new Map() };
  const outDefs: Record<string, SchemaObject> = {};
  for (const name of defNames) {
    const n = node(defs[name]!, defPaths[name]!, ctx);
    outDefs[name] = n.schema;
    ctx.defDecoders.set(name, n.decode);
  }
  // A root that is only a reference to a recursive def: use the def's body as the root.
  const rootRef = typeof root.$ref === "string" && Object.keys(root).length === 1 ? root.$ref.replace(/^#\/\$defs\//, "") : undefined;
  const top = rootRef !== undefined && has(outDefs, rootRef) ? { schema: outDefs[rootRef]!, decode: ctx.defDecoders.get(rootRef) } : node(root, "#", ctx);
  let final = top.schema;
  let decode = top.decode;
  const isPlainObject = isRootObject(final);
  if (caps.rootObject && !isPlainObject) {
    final = { type: "object", properties: { value: final }, required: ["value"], additionalProperties: false };
    const inner = decode;
    decode = (v) => {
      const x = isObj(v) ? v.value : v;
      return inner ? inner(x) : x;
    };
    loss(ctx, "#", "type", typesOf(top.schema), "restructured", `the root must be an object for ${caps.id}; the schema is wrapped as {"value": ...} and decode() unwraps it`);
  }
  if (defNames.length > 0) final = { ...final, $defs: outDefs };
  ctx.final = final;
  measure(final, caps, "#");

  if (options.lossless) {
    const first = ctx.losses.find((l) => l.action !== "rewritten");
    if (first) throw new UnsupportedSchemaError(first.path, caps.id, `strict: ${first.note}`);
  }

  return {
    schema: final,
    field: caps.fields[use],
    target: caps,
    losses: ctx.losses,
    decode: (output) => (decode ? decode(output) : output),
    check: (value) => {
      const errors = validate(value, original);
      return { valid: errors.length === 0, errors };
    },
  };
}

const isRootObject = (s: SchemaObject) => s.type === "object" && !Array.isArray(s.anyOf) && !Array.isArray(s.oneOf) && !Array.isArray(s.allOf) && s.$ref === undefined;

/** Non-strict targets accept any JSON Schema; only the root rule applies. The schema is otherwise sent as written. */
function looseConvert(schema: JSONSchema, caps: Capabilities, use: "tool" | "output"): ConvertResult {
  const original = normalize(schema);
  const losses: Loss[] = [];
  let out = JSON.parse(JSON.stringify(typeof schema === "boolean" ? original : schema)) as SchemaObject;
  delete out.$schema;
  let decode: Decoder | undefined;
  if (caps.rootObject && !isRootObject(out)) {
    const flat = Array.isArray(out.allOf) && out.type === undefined ? flattenAllOf(out) : null;
    const merged = flat ? null : mergeObjectUnion(out);
    if (flat && isRootObject(flat)) {
      out = flat;
      losses.push({ path: "#", keyword: "allOf", action: "rewritten", note: "root allOf merged into a single object" });
    } else if (merged) {
      out = merged.schema;
      losses.push({
        path: "#",
        keyword: merged.keyword,
        action: "relaxed",
        note: `root ${merged.keyword} of objects merged into one object (fields common to every variant stay required); the output shape is unchanged and check() enforces the exact variants`,
      });
    } else {
      const { $defs, definitions, ...body } = out;
      out = { type: "object", properties: { value: body }, required: ["value"] };
      if ($defs !== undefined) out.$defs = $defs as Record<string, JSONSchema>;
      if (definitions !== undefined) out.definitions = definitions;
      decode = (v) => (isObj(v) ? v.value : v);
      losses.push({ path: "#", keyword: "type", action: "restructured", note: `tool parameters must be an object for ${caps.id}; the schema is wrapped as {"value": ...} and decode() unwraps it` });
    }
  }
  return {
    schema: out,
    field: caps.fields[use],
    target: caps,
    losses,
    decode: (v) => (decode ? decode(v) : v),
    check: (value) => {
      const errors = validate(value, original);
      return { valid: errors.length === 0, errors };
    },
  };
}

/**
 * A root union whose variants are all objects, merged into one object: every field from every variant, required
 * only when every variant requires it. The model's output keeps its shape, so nothing needs decoding (which
 * matters for proxies that stream tool arguments). Returns null when a variant isn't a plain object.
 */
function mergeObjectUnion(root: SchemaObject): { schema: SchemaObject; keyword: "anyOf" | "oneOf" } | null {
  const keyword = Array.isArray(root.anyOf) ? "anyOf" : Array.isArray(root.oneOf) ? "oneOf" : null;
  if (!keyword) return null;
  const { [keyword]: list, ...rest } = root;
  const others = Object.keys(rest).filter((k) => !["description", "title", "$defs", "definitions", "type"].includes(k));
  if (others.length > 0 || (rest.type !== undefined && rest.type !== "object")) return null;
  const variants: SchemaObject[] = [];
  for (const v of list as unknown[]) {
    let b = v;
    for (let i = 0; i < 10 && isObj(b) && typeof b.$ref === "string"; i++) {
      try {
        b = resolvePointer(root, b.$ref as string, "#", "merge");
      } catch {
        return null;
      }
    }
    if (!isObj(b) || (b.type !== "object" && !(b.type === undefined && isObj(b.properties)))) return null;
    if (Array.isArray(b.anyOf) || Array.isArray(b.oneOf) || Array.isArray(b.allOf)) return null;
    variants.push(b as SchemaObject);
  }
  if (variants.length === 0) return null;
  const properties: Record<string, JSONSchema[]> = {};
  for (const v of variants) {
    for (const [k, p] of Object.entries((isObj(v.properties) ? v.properties : {}) as Record<string, JSONSchema>)) {
      const seen = (properties[k] ??= []);
      if (!seen.some((x) => deepEqual(x, p))) seen.push(p);
    }
  }
  const req = (v: SchemaObject) => new Set(Array.isArray(v.required) ? v.required : []);
  const required = Object.keys(properties).filter((k) => variants.every((v) => req(v).has(k)));
  const out: SchemaObject = { type: "object" };
  if (typeof rest.description === "string") out.description = rest.description;
  out.properties = Object.fromEntries(Object.entries(properties).map(([k, list]) => [k, list.length === 1 ? list[0]! : mergeAlternatives(list)]));
  if (required.length > 0) out.required = required;
  if (rest.$defs !== undefined) out.$defs = rest.$defs as Record<string, JSONSchema>;
  if (rest.definitions !== undefined) out.definitions = rest.definitions;
  return { schema: out, keyword };
}

/** Alternatives for one field. Constants and enums (a discriminator, usually) become one enum. */
function mergeAlternatives(list: JSONSchema[]): JSONSchema {
  const values: unknown[] = [];
  let type: unknown;
  for (const p of list) {
    if (!isObj(p)) return { anyOf: list };
    const keys = Object.keys(p).filter((k) => k !== "type" && k !== "description");
    if (keys.length !== 1 || (keys[0] !== "const" && keys[0] !== "enum")) return { anyOf: list };
    if (p.type !== undefined) {
      if (type !== undefined && !deepEqual(type, p.type)) return { anyOf: list };
      type = p.type;
    }
    for (const v of keys[0] === "const" ? [p.const] : Array.isArray(p.enum) ? p.enum : []) if (!values.some((x) => deepEqual(x, v))) values.push(v);
  }
  return type === undefined ? { enum: values } : { type, enum: values } as SchemaObject;
}
