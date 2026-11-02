# Changelog

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
