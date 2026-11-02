import { UnsupportedSchemaError } from "./errors.js";
import type { JSONSchema, SchemaObject } from "./types.js";

export const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is a single subschema. */
const SINGLE = ["additionalProperties", "items", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "additionalItems"];
/** Keywords whose value is an array of subschemas. */
const ARRAY = ["anyOf", "oneOf", "allOf", "prefixItems"];
/** Keywords whose value is a map of subschemas. */
const MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

/** Call `fn` on every direct subschema of `s`. */
export function eachChild(s: SchemaObject, fn: (child: JSONSchema, key: string, sub?: string | number) => void): void {
  for (const k of SINGLE) if (has(s, k) && (isObj(s[k]) || typeof s[k] === "boolean")) fn(s[k] as JSONSchema, k);
  for (const k of ARRAY) if (Array.isArray(s[k])) (s[k] as JSONSchema[]).forEach((c, i) => fn(c, k, i));
  for (const k of MAP) if (isObj(s[k])) for (const [name, c] of Object.entries(s[k] as object)) fn(c as JSONSchema, k, name);
}

/** JSON Pointer token escaping. */
export const esc = (t: string | number) => String(t).replace(/~/g, "~0").replace(/\//g, "~1");
const unesc = (t: string) => decodeURIComponent(t).replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Deep-copies the schema into one dialect: draft-07 spellings become 2020-12 (`definitions` → `$defs`,
 * array `items` → `prefixItems`, `dependencies` split), OpenAPI `nullable` becomes a null type,
 * boolean schemas become `{}` / `{ not: {} }`, and `$schema` / `$id` / `$comment` are removed.
 */
export function normalize(input: JSONSchema): SchemaObject {
  const walk = (s: unknown): SchemaObject => {
    if (s === true || s === undefined) return {};
    if (s === false) return { not: {} };
    if (!isObj(s)) throw new TypeError(`Expected a JSON Schema object, got ${JSON.stringify(s)}`);
    const out: SchemaObject = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "$schema" || k === "$id" || k === "$comment") continue;
      out[k] = v;
    }
    if (has(out, "definitions")) {
      out.$defs = { ...(out.definitions as object), ...(out.$defs ?? {}) };
      delete out.definitions;
    }
    if (typeof out.$ref === "string") out.$ref = out.$ref.replace(/^#\/definitions\//, "#/$defs/");
    if (Array.isArray(out.items)) {
      out.prefixItems = out.items;
      if (has(out, "additionalItems")) out.items = out.additionalItems as JSONSchema;
      else delete out.items;
      delete out.additionalItems;
    }
    if (isObj(out.dependencies)) {
      for (const [name, dep] of Object.entries(out.dependencies)) {
        const key = Array.isArray(dep) ? "dependentRequired" : "dependentSchemas";
        out[key] = { ...((out[key] as object) ?? {}), [name]: dep };
      }
      delete out.dependencies;
    }
    if (out.nullable === true) {
      const t = out.type;
      if (typeof t === "string") out.type = [t, "null"];
      else if (Array.isArray(t) && !t.includes("null")) out.type = [...t, "null"];
      delete out.nullable;
    } else if (out.nullable === false) delete out.nullable;
    // Draft-04 boolean exclusive bounds.
    for (const [ex, base] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
      if (typeof out[ex] === "boolean") {
        if (out[ex] === true && typeof out[base] === "number") {
          out[ex] = out[base];
          delete out[base];
        } else delete out[ex];
      }
    }
    // Boolean values stay booleans here (additionalProperties: false, items: false); elsewhere they become schemas.
    for (const k of SINGLE) if (has(out, k) && typeof out[k] !== "boolean") out[k] = walk(out[k]);
    for (const k of ARRAY) if (Array.isArray(out[k])) out[k] = (out[k] as unknown[]).map(walk);
    for (const k of MAP) {
      if (isObj(out[k])) out[k] = Object.fromEntries(Object.entries(out[k] as object).map(([n, c]) => [n, walk(c)]));
    }
    return out;
  };
  return walk(input);
}

/** Resolves a local `$ref` ("#", "#/$defs/X", any JSON Pointer) against the root. */
export function resolvePointer(root: SchemaObject, ref: string, at: string, target: string): SchemaObject {
  if (!ref.startsWith("#")) {
    throw new UnsupportedSchemaError(at, target, `external $ref "${ref}" can't be resolved`, "Bundle the referenced schema into $defs first");
  }
  if (ref === "#" || ref === "#/") return root;
  let node: unknown = root;
  for (const token of ref.slice(2).split("/").map(unesc)) {
    node = isObj(node) ? node[token] : Array.isArray(node) ? node[Number(token)] : undefined;
    if (node === undefined) throw new UnsupportedSchemaError(at, target, `$ref "${ref}" points to nothing`);
  }
  if (!isObj(node)) throw new UnsupportedSchemaError(at, target, `$ref "${ref}" doesn't point to a schema`);
  return node as SchemaObject;
}

/** Annotation-only keywords: a `$ref` with only these beside it can be merged by overriding. */
const ANNOTATIONS = new Set(["description", "title", "default", "examples", "deprecated", "readOnly", "writeOnly"]);

export interface Dereferenced {
  /** The root with every non-recursive `$ref` inlined. */
  root: SchemaObject;
  /** Recursive targets, by `$defs` name. Their `$ref`s are rewritten to "#/$defs/<name>". */
  defs: Record<string, SchemaObject>;
  /** Pointer in the original schema for each kept def, for loss paths. */
  defPaths: Record<string, string>;
  /** Where a `$ref` was replaced by its target, with the reference. */
  inlined: { path: string; ref: string }[];
}

/**
 * Inlines every `$ref` except recursive ones. A `$ref` with sibling keywords becomes the target with the
 * siblings applied (annotations override; other keywords are combined through `allOf`).
 */
export function dereference(root: SchemaObject, target: string): Dereferenced {
  const defs: Record<string, SchemaObject> = {};
  const defPaths: Record<string, string> = {};
  const inlined: { path: string; ref: string }[] = [];
  const names = new Map<string, string>(); // ref -> def name
  const nameFor = (ref: string) => {
    let n = names.get(ref);
    if (n) return n;
    const base = ref === "#" || ref === "#/" ? "Root" : (unesc(ref.split("/").pop() || "Def").replace(/[^A-Za-z0-9_.-]/g, "_") || "Def");
    n = base;
    for (let i = 2; Object.values(Object.fromEntries(names)).includes(n); i++) n = `${base}_${i}`;
    names.set(ref, n);
    return n;
  };

  const expand = (s: SchemaObject, path: string, stack: readonly string[]): SchemaObject => {
    if (typeof s.$ref === "string") {
      const ref = s.$ref;
      const siblings: SchemaObject = {};
      for (const [k, v] of Object.entries(s)) if (k !== "$ref" && k !== "$defs") siblings[k] = v;
      if (stack.includes(ref)) {
        // Recursive: keep a reference, expand the target once into defs.
        const name = nameFor(ref);
        return { ...siblings, $ref: `#/$defs/${name}` };
      }
      if (names.has(ref) && has(defs, names.get(ref)!)) {
        return expandSiblings({ $ref: `#/$defs/${names.get(ref)!}` }, siblings, path, stack);
      }
      const resolved = resolvePointer(root, ref, path, target);
      const body = expand(resolved, ref === "#/" ? "#" : ref, [...stack, ref]);
      if (names.has(ref) && !has(defs, names.get(ref)!)) {
        // The target turned out to be recursive: store it as a def and point at it.
        const name = names.get(ref)!;
        defs[name] = body;
        defPaths[name] = ref;
        return expandSiblings({ $ref: `#/$defs/${name}` }, siblings, path, stack);
      }
      inlined.push({ path, ref });
      return expandSiblings(body, siblings, path, stack);
    }
    const out: SchemaObject = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "$defs") continue; // Reachable defs are inlined or re-collected; unreachable ones are dropped.
      out[k] = v;
    }
    for (const k of SINGLE) if (isObj(out[k])) out[k] = expand(out[k] as SchemaObject, `${path}/${k}`, stack);
    for (const k of ARRAY) {
      if (Array.isArray(out[k])) out[k] = (out[k] as SchemaObject[]).map((c, i) => expand(c, `${path}/${k}/${i}`, stack));
    }
    for (const k of MAP) {
      if (k === "$defs" || !isObj(out[k])) continue;
      out[k] = Object.fromEntries(Object.entries(out[k] as object).map(([n, c]) => [n, expand(c as SchemaObject, `${path}/${k}/${esc(n)}`, stack)]));
    }
    return out;
  };

  const expandSiblings = (body: SchemaObject, siblings: SchemaObject, path: string, stack: readonly string[]): SchemaObject => {
    const keys = Object.keys(siblings);
    if (keys.length === 0) return body;
    const expandedSiblings = expand(siblings, path, stack);
    if (keys.every((k) => ANNOTATIONS.has(k)) && body.$ref === undefined) return { ...body, ...expandedSiblings };
    return { allOf: [body, expandedSiblings] };
  };

  // "#" refs anywhere make the root itself recursive.
  const expandedRoot = expand(root, "#", ["#", "#/"]);
  if (names.has("#/") && !names.has("#")) names.set("#", names.get("#/")!);
  if (names.has("#") && !has(defs, names.get("#")!)) {
    defs[names.get("#")!] = expandedRoot;
    defPaths[names.get("#")!] = "#";
  }
  return { root: expandedRoot, defs, defPaths, inlined };
}
