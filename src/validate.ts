// Adapted from nanoharness's validator (same author, MIT).
import { esc, has, isObj, resolvePointer } from "./refs.js";
import type { CheckError, SchemaObject } from "./types.js";

// Deeper input than this is refused rather than risking a stack overflow.
const MAX_DEPTH = 256;
// Pattern matching on a very long string can stall the process, so long strings are refused up front.
const MAX_PATTERN_INPUT = 100_000;

class TooDeep extends Error {}

const regexCache = new Map<string, RegExp | null>();
// Unicode mode, so "." matches an emoji as one character; patterns that mode rejects fall back to plain mode.
function regex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, "u");
  } catch {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
  }
  regexCache.set(pattern, re);
  return re;
}

export function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === "integer") return Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

/** Structural equality for JSON values. */
export function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) throw new TooDeep();
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((v, i) => deepEqual(v, other[i], depth + 1));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => has(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1));
}

const FORMATS: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  time: /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/,
  duration: /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  hostname: /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/,
  ipv4: /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  ipv6: /^[0-9A-Fa-f:.]{2,45}$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  uri: /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/,
};

/**
 * Validates `value` against a normalized schema. Covers the 2020-12 assertion keywords, local `$ref`s,
 * and the common formats; `unevaluated*` and `$dynamicRef` are not enforced. Returns every error found.
 */
export function validate(value: unknown, root: SchemaObject): CheckError[] {
  const errors: CheckError[] = [];
  try {
    run(value, root, root, "", 0, errors);
  } catch (e) {
    if (e instanceof TooDeep) return [{ path: "", message: "nested too deeply to check" }];
    throw e;
  }
  return errors;
}

/** True when the value matches. Used to choose an anyOf branch while decoding. */
export function matches(value: unknown, schema: SchemaObject, root: SchemaObject = schema): boolean {
  try {
    const errors: CheckError[] = [];
    run(value, schema, root, "", 0, errors);
    return errors.length === 0;
  } catch (e) {
    if (e instanceof TooDeep) return false;
    throw e;
  }
}

function run(value: unknown, schema: SchemaObject, root: SchemaObject, path: string, depth: number, errors: CheckError[]): void {
  if (depth > MAX_DEPTH) throw new TooDeep();
  const fail = (message: string, at = path) => void errors.push({ path: at, message });
  const sub = (v: unknown, s: unknown, p: string, into = errors) => {
    if (s === true || s === undefined) return;
    if (s === false) return void into.push({ path: p, message: "not allowed" });
    if (isObj(s)) run(v, s as SchemaObject, root, p, depth + 1, into);
  };
  const passes = (s: unknown) => {
    const scratch: CheckError[] = [];
    sub(value, s, path, scratch);
    return scratch.length === 0;
  };

  if (typeof schema.$ref === "string") sub(value, resolvePointer(root, schema.$ref, path, "check"), path);

  if (schema.type !== undefined && !(value === null && (schema as Record<string, unknown>).nullable === true)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) return fail(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    fail(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (has(schema, "const") && !deepEqual(value, schema.const)) fail(`must equal ${JSON.stringify(schema.const)}`);

  if (typeof value === "number") {
    const s = schema as Record<string, unknown>;
    if (typeof s.minimum === "number" && value < s.minimum) fail(`must be >= ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) fail(`must be <= ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) fail(`must be > ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) fail(`must be < ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
      const q = value / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) fail(`must be a multiple of ${s.multipleOf}`);
    }
  }

  if (typeof value === "string") {
    const s = schema as Record<string, unknown>;
    // JSON Schema counts code points, not UTF-16 units, so an emoji is one character.
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) fail(`must be at least ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && length > s.maxLength) fail(`must be at most ${s.maxLength} characters`);
    if (typeof s.pattern === "string") {
      const re = regex(s.pattern);
      if (value.length > MAX_PATTERN_INPUT) fail("too long to check against its pattern");
      else if (re && !re.test(value)) fail(`must match ${s.pattern}`);
    }
    if (typeof s.format === "string" && FORMATS[s.format] && !FORMATS[s.format]!.test(value)) fail(`must be a valid ${s.format}`);
  }

  if (isObj(value)) {
    const s = schema as Record<string, unknown>;
    const props = (isObj(s.properties) ? s.properties : {}) as Record<string, unknown>;
    const patterns = (isObj(s.patternProperties) ? s.patternProperties : {}) as Record<string, unknown>;
    const keys = Object.keys(value);
    if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!has(value, k)) fail("required", `${path}/${esc(k)}`);
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) fail(`needs at least ${s.minProperties} properties`);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) fail(`allows at most ${s.maxProperties} properties`);
    for (const k of keys) {
      const p = `${path}/${esc(k)}`;
      let known = false;
      if (has(props, k)) {
        known = true;
        sub(value[k], props[k], p);
      }
      for (const [pat, ps] of Object.entries(patterns)) {
        if (regex(pat)?.test(k)) {
          known = true;
          sub(value[k], ps, p);
        }
      }
      if (!known && has(s, "additionalProperties")) sub(value[k], s.additionalProperties, p);
      if (has(s, "propertyNames")) sub(k, s.propertyNames, p);
    }
    if (isObj(s.dependentRequired)) {
      for (const [k, deps] of Object.entries(s.dependentRequired)) {
        if (has(value, k) && Array.isArray(deps)) for (const d of deps as string[]) if (!has(value, d)) fail(`required when ${k} is present`, `${path}/${esc(d)}`);
      }
    }
    if (isObj(s.dependentSchemas)) for (const [k, ds] of Object.entries(s.dependentSchemas)) if (has(value, k)) sub(value, ds, path);
  }

  if (Array.isArray(value)) {
    const s = schema as Record<string, unknown>;
    if (typeof s.minItems === "number" && value.length < s.minItems) fail(`needs at least ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) fail(`allows at most ${s.maxItems} items`);
    if (s.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        if (value.slice(0, i).some((v) => deepEqual(v, value[i]))) {
          fail("items must be unique");
          break;
        }
      }
    }
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : [];
    value.forEach((v, i) => sub(v, i < prefix.length ? prefix[i] : s.items, `${path}/${i}`));
    if (has(s, "contains")) {
      const n = value.filter((v) => {
        const scratch: CheckError[] = [];
        sub(v, s.contains, path, scratch);
        return scratch.length === 0;
      }).length;
      const min = typeof s.minContains === "number" ? s.minContains : 1;
      if (n < min) fail(`needs at least ${min} matching item${min === 1 ? "" : "s"}`);
      if (typeof s.maxContains === "number" && n > s.maxContains) fail(`allows at most ${s.maxContains} matching items`);
    }
  }

  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) sub(value, s, path);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(passes)) fail("does not match any of the allowed schemas");
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter(passes).length;
    if (n !== 1) fail(`must match exactly one of the allowed schemas (matched ${n})`);
  }
  const s = schema as Record<string, unknown>;
  if (has(s, "not") && passes(s.not)) fail("matches a schema it must not match");
  if (has(s, "if")) sub(value, passes(s.if) ? s.then : s.else, path);
}
