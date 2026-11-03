# Changelog

## 0.7.0 (2026-11-02)

- **Ollama target:** `"ollama"` / `"ollama/<model>"`, from Ollama's docs and source (checked 2026-11-02).
  - **Tools:** keywords that Ollama silently drops are moved to the description.
  - **`use: "output"`:** follows llama.cpp's grammar converter. Patterns are anchored, `prefixItems`, nested `$ref`s and number bounds are avoided, and objects are closed by default.
- **`resolveTarget(target, { strict, use })`** now takes `use`, for providers whose rules differ between tools and output.
- **Changed:** patterns widened for whole-string targets are now anchored (`@` → `^.*(?:@).*$` instead of `.*(?:@).*`). Same meaning, and it also satisfies targets that require `^…$`. Target rules are now checked against the widened pattern.

## 0.6.0 (2026-11-02)

- **Mistral target:** `"mistral"` / `"mistral/<model>"`. Mistral's docs (checked 2026-11-02) list no JSON Schema rules for tools or structured output, so the schema is sent as written, with an object root for tool parameters. Rules will be added if probes or docs show rejections.

## 0.5.0 (2026-11-02)

- **DeepSeek target:** `"deepseek"` / `"deepseek/<model>"` follows DeepSeek's strict tool-call rules (beta endpoint, checked 2026-11-02). Every property is required, objects are closed, and recursion uses `$def`. String and array bounds move to the description. `strict: false` sends the schema as written.
- **New capability `defsKeyword`:** for targets that spell `$defs` differently. DeepSeek documents `$def`, and references are rewritten to match.

## 0.4.0 (2026-11-02)

- **xAI target:** `"xai"` / `"xai/<model>"` / `"grok"` follows xAI's documented rules (checked 2026-11-02). Optional fields are allowed, bounds and `const` are kept, enforced formats are kept, and there's no recursion.
- **New capability `patternFullMatch`:** for targets that match `pattern` against the whole string, unanchored patterns are widened so they keep their JSON Schema meaning. Recorded as `rewritten`.
- **New capability `closedByDefault`:** for targets whose objects are closed unless told otherwise, free-form objects get `additionalProperties: true`.

## 0.3.0 (2026-11-02)

- **Groq target:** `"groq"` / `"groq/<model>"` follows Groq's strict structured-output rules (all properties required, closed objects, `$defs`/`$ref`, recursion). `strict: false` sends the schema as written, with an object root. Rules come from Groq's docs (checked 2026-11-02).
- **Tests:** a shared conformance check (`test/conformance.mjs`) validates converted schemas against any target's rules.

## 0.2.2 (2026-11-02)

- **Compatibility table:** [docs/compatibility.md](docs/compatibility.md), generated from live probe results (Gemini, 59 checks) and the documented rules (OpenAI, Anthropic). The raw results are in `docs/probe-results/`. Regenerate with `npm run compat`.
- **Probe:** fixed the expectation for the "empty schema" check.

## 0.2.1 (2026-11-02)

- **Gemini (`google`):** draft-07 spellings (array `items`, `definitions`, `nullable`) are now rewritten to 2020-12. A live probe showed Gemini rejects array-form `items`.
- **`losses`** now lists inlined `$ref`s, as `rewritten`.
- **README:** non-strict root unions of objects are described as merged, not wrapped. `strict: false` applies to OpenAI and Anthropic only. The stability promise no longer overstates what's been tested live.

## 0.2.0 (2026-11-02)

- **Gemini support.**
  - `"google"` / `"gemini/<model>"` target Gemini's JSON Schema fields (`parametersJsonSchema`, `responseJsonSchema`). Live probes accepted every keyword tried, so schemas are sent as written there.
  - `"google-openapi"` / `"vertex"` target the OpenAPI `Schema` fields (`parameters`, `responseSchema`): upper-case types, `nullable`, string-only enums, and no `additionalProperties`.
- **Fixed:** a wrapped root no longer adds `additionalProperties: false` for targets that don't accept it.
- **Fixed:** maps are kept as maps for targets that accept `additionalProperties`, instead of being JSON-encoded. `patternProperties` maps still become entries where needed.
- **Probes:** `scripts/probe.mjs` can test Gemini with a free Google AI Studio key (`GEMINI_API_KEY`). It retries busy and rate-limited responses, and its default Gemini model is now `gemini-3.5-flash-lite`.
- **CI:** builds on Node 24 and tests the built package on Node 18, 20, 22 and 24.

## 0.1.1 (2026-11-02)

- Add repository, issues and homepage links (github.com/buildwithnikhil/llm-json-schema). No code changes.

## 0.1.0 (2026-11-02)

First release.

- **`convert(schema, { target, use, strict, lossless })`** rewrites a JSON Schema (draft-07 or 2020-12) into the form a provider accepts. It returns `schema`, `field`, `losses`, `decode()` and `check()`.
- **Targets:**
  - `openai` and `openai/<model>`: strict function calling and Structured Outputs.
  - `openai/ft:<model>`: fine-tuned models, which also lose `pattern`, `format`, number bounds and array sizes.
  - `anthropic` and `anthropic/<model>`: strict tool use and JSON outputs.
  - Non-strict tools for either provider, with `strict: false`.
  - Custom capabilities objects.
- **Non-strict root unions of objects are merged into one object,** so the model's arguments keep their shape and need no decoding.
- **`fromAny()`** accepts Zod 4 and other Standard JSON Schema libraries without importing them.
- **The rules come from the provider documentation** (checked 2026-11-02). Where the docs say nothing, the keyword is treated as unsupported. Live API probes (`npm run probe`) haven't been run yet; corrections will ship as patch releases.
