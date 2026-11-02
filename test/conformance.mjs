import assert from "node:assert/strict";

/**
 * Throws unless `schema` follows the rules in `caps` (a Capabilities object): only allowed keywords and values,
 * closed objects and required properties where demanded, an object root, and the target's limits.
 */
export function assertConforms(schema, caps) {
  const allowed = caps.keywords === "any" ? null : new Set([...caps.keywords, ...(caps.nullableKeyword ? ["nullable"] : [])]);
  const defsKey = caps.defsKeyword ?? "$defs";
  let optional = 0;
  let unions = 0;
  const walk = (s, at, depth, isRoot) => {
    assert.equal(typeof s, "object", `${at}: schema must be an object`);
    if (allowed) for (const k of Object.keys(s)) assert.ok(allowed.has(k) || k === defsKey, `${at}: keyword "${k}" isn't accepted by ${caps.id}`);
    for (const [k, rule] of Object.entries(caps.rules ?? {})) if (k in s) assert.ok(rule(s[k]), `${at}: ${k}=${JSON.stringify(s[k])} isn't accepted by ${caps.id}`);
    if (s.format !== undefined && caps.formats !== "any") assert.ok(caps.formats.includes(s.format), `${at}: format ${s.format}`);
    if (s.$ref !== undefined) {
      assert.ok(caps.refs, `${at}: ${caps.id} doesn't accept $ref`);
      if (!caps.refSiblings) assert.deepEqual(Object.keys(s), ["$ref"], `${at}: $ref must have no siblings`);
      return;
    }
    if (isRoot && caps.rootObject) {
      assert.equal(String(s.type).toLowerCase(), "object", "root must be type object");
      assert.equal(s.anyOf, undefined, "root must not be a union");
    }
    if (!caps.typeArrays) assert.ok(!Array.isArray(s.type), `${at}: ${caps.id} doesn't accept type arrays`);
    const types = s.type === undefined ? [] : [].concat(s.type).map((t) => String(t).toLowerCase());
    if (!caps.openSchemas && !s.anyOf && s.enum === undefined && s.const === undefined) assert.ok(types.length > 0, `${at}: needs a type`);
    if (types.includes("object")) {
      if (caps.closedObjects) assert.equal(s.additionalProperties, false, `${at}: additionalProperties must be false`);
      const req = new Set(s.required ?? []);
      if (caps.allRequired) assert.deepEqual([...req].sort(), Object.keys(s.properties ?? {}).sort(), `${at}: every property must be required`);
      for (const [k, c] of Object.entries(s.properties ?? {})) {
        if (!req.has(k)) optional++;
        if (c.anyOf || (Array.isArray(c.type) && c.type.length > 1)) unions++;
        if (caps.limits.maxDepth) assert.ok(depth + 1 <= caps.limits.maxDepth, `${at}: too deep`);
        walk(c, `${at}/properties/${k}`, depth + 1, false);
      }
      if (typeof s.additionalProperties === "object") walk(s.additionalProperties, `${at}/additionalProperties`, depth + 1, false);
    }
    if (types.includes("array") && s.items && typeof s.items === "object") walk(s.items, `${at}/items`, depth + 1, false);
    if (Array.isArray(s.prefixItems)) s.prefixItems.forEach((c, i) => walk(c, `${at}/prefixItems/${i}`, depth + 1, false));
    if (s.anyOf) s.anyOf.forEach((b, i) => walk(b, `${at}/anyOf/${i}`, depth, false));
    if (s[defsKey]) for (const [k, d] of Object.entries(s[defsKey])) walk(d, `#/${defsKey}/${k}`, 1, false);
  };
  walk(schema, "#", 1, true);
  if (caps.limits.maxOptionalProperties !== undefined) assert.ok(optional <= caps.limits.maxOptionalProperties);
  if (caps.limits.maxUnionProperties !== undefined) assert.ok(unions <= caps.limits.maxUnionProperties);
}
