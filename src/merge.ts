import { has, isObj } from "./refs.js";
import type { SchemaObject } from "./types.js";
import { deepEqual } from "./validate.js";

const LOWER = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains"];
const UPPER = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains"];
const TEXT = ["description", "title"];

const typesOf = (s: SchemaObject): string[] | undefined =>
  s.type === undefined ? undefined : Array.isArray(s.type) ? s.type : [s.type];

function intersectTypes(a: string[] | undefined, b: string[] | undefined): string[] | undefined | null {
  if (!a) return b;
  if (!b) return a;
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (x === y) out.add(x);
      else if ((x === "integer" && y === "number") || (x === "number" && y === "integer")) out.add("integer");
    }
  }
  return out.size === 0 ? null : [...out];
}

/**
 * Merges two schemas into one that accepts exactly what both accept, for the common cases (object
 * intersections, stacked constraints, a union on one side). Returns null when no single schema can say it.
 */
export function mergeTwo(a: SchemaObject, b: SchemaObject): SchemaObject | null {
  // A union on one side: distribute, (A or B) and C = (A and C) or (B and C).
  for (const [u, other] of [[a, b], [b, a]] as const) {
    if (Array.isArray(u.anyOf) && !Array.isArray(other.anyOf)) {
      const { anyOf, ...rest } = u;
      const base = mergeTwo(rest, other);
      if (!base) return null;
      const branches = anyOf.map((br) => (isObj(br) ? mergeTwo(base, br as SchemaObject) : null));
      if (branches.some((x) => x === null)) return null;
      return { anyOf: branches as SchemaObject[] };
    }
  }
  if (Array.isArray(a.anyOf) && Array.isArray(b.anyOf)) return null;

  const out: SchemaObject = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const inA = has(a, k);
    const inB = has(b, k);
    const va = a[k];
    const vb = b[k];
    if (!inA || !inB) {
      out[k] = inA ? va : vb;
      continue;
    }
    if (deepEqual(va, vb)) {
      out[k] = va;
      continue;
    }
    if (k === "type") {
      const t = intersectTypes(typesOf(a), typesOf(b));
      if (t === null) return null;
      out.type = t && t.length === 1 ? t[0] : t;
    } else if (LOWER.includes(k) && typeof va === "number" && typeof vb === "number") out[k] = Math.max(va, vb);
    else if (UPPER.includes(k) && typeof va === "number" && typeof vb === "number") out[k] = Math.min(va, vb);
    else if (TEXT.includes(k) && typeof va === "string" && typeof vb === "string") out[k] = `${va} ${vb}`;
    else if (k === "required" && Array.isArray(va) && Array.isArray(vb)) out.required = [...new Set([...va, ...vb])];
    else if (k === "enum" && Array.isArray(va) && Array.isArray(vb)) {
      const both = va.filter((x) => vb.some((y) => deepEqual(x, y)));
      if (both.length === 0) return null;
      out.enum = both;
    } else if (k === "properties" && isObj(va) && isObj(vb)) {
      const props: Record<string, SchemaObject> = { ...(va as Record<string, SchemaObject>) };
      for (const [name, sb] of Object.entries(vb as Record<string, SchemaObject>)) {
        if (!has(props, name)) props[name] = sb;
        else {
          const m = mergeTwo(props[name]!, sb);
          if (!m) return null;
          props[name] = m;
        }
      }
      out.properties = props;
    } else if ((k === "items" || k === "additionalProperties") && isObj(va) && isObj(vb)) {
      const m = mergeTwo(va as SchemaObject, vb as SchemaObject);
      if (!m) return null;
      out[k] = m;
    } else if (k === "additionalProperties" && (va === false || vb === false)) {
      // Both sides list their own properties; the usual intent (Zod intersections, TypeBox Intersect) is a union of them.
      out.additionalProperties = false;
    } else if (k === "allOf" && Array.isArray(va) && Array.isArray(vb)) out.allOf = [...va, ...vb];
    else return null;
  }
  if (Array.isArray(out.enum) && out.type !== undefined) {
    const t = typesOf(out)!;
    const kept = out.enum.filter((x) => t.some((ty) => (ty === "integer" ? Number.isInteger(x) : ty === "null" ? x === null : ty === "array" ? Array.isArray(x) : ty === "object" ? isObj(x) : typeof x === ty)));
    if (kept.length === 0) return null;
    out.enum = kept;
  }
  return out;
}

/** Folds `allOf` into its parent. Returns null when the parts can't be combined into one schema. */
export function flattenAllOf(s: SchemaObject): SchemaObject | null {
  if (!Array.isArray(s.allOf)) return s;
  const { allOf, ...rest } = s;
  let acc: SchemaObject | null = rest;
  for (const part of allOf) {
    if (!isObj(part)) return null;
    const flat = flattenAllOf(part as SchemaObject);
    if (!flat) return null;
    acc = mergeTwo(acc, flat);
    if (!acc) return null;
  }
  return acc;
}
