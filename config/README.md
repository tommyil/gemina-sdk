# Generator decisions (Phase B2 evaluation, 2026-07-04)

**Pinned generator:** `openapitools/openapi-generator-cli:v7.23.0`
(digest `sha256:5ffccd3b0d4ac57eac443e1c9b3e2f2bb7f0a21ffe6c6701f3690d7edc78bf2d`).
`latest` was a 7.24.0-SNAPSHOT — never pin a snapshot.

**OpenAPI 3.1:** all five generators consumed the FastAPI-emitted 3.1 spec
directly (the generator prints a "3.1 support is beta" warning; harmless).
No 3.0 down-convert step is needed. `tools/generate.py` retains a
`downconvert` config hook per language in case a future generator regresses.

Every choice below was validated by: generate → compile in Docker → (Python)
live smoke call against production.

| Language | Generator / flavor | Why |
|----------|--------------------|-----|
| TypeScript | `typescript-fetch` | Zero runtime deps (native `fetch`), browser + Node ≥18, tree-shakeable. `typescript-axios` would add a dependency for no gain. |
| Python | `python` + `library=httpx` | Fully async client (matches the SDK's async-first design), modern httpx transport, pydantic v2 models. `urllib3` flavor is sync-only; `asyncio` flavor pulls aiohttp. |
| C# | `csharp` + `library=restsharp`, `targetFramework=netstandard2.0` | The classic, stable client surface (`Configuration` + `*Api`). `httpclient` flavor is marked *experimental* by the generator; `generichost` forces DI-style consumption that hurts quickstart simplicity. netstandard2.0 reaches .NET Framework 4.6.2+ and every modern .NET. |
| Java | `java` + `library=okhttp-gson` | The generator's default and most battle-tested flavor. Sync calls fit the blocking-with-timeout helper design. |
| PHP | `php` (Guzzle-based) | Only maintained PHP flavor. Single `Gemina\Sdk` namespace (generated `lib/` + hand-written `src/` map to the same prefix via PSR-4 array). |

**Known benign generator warnings:** `datatypeWithEnum from ExtractionTypeModel null`
(enums still generate correctly in every language — verified), and the 3.1-beta notice.

**Layout rule:** generated code is copied into a dedicated wiped directory per
package (`copy` rules in `languages.json`); package manifests
(package.json / pyproject.toml / csproj / pom.xml / composer.json) are
**hand-written** and own dependencies + version. Generator-emitted manifests
are discarded (`exclude` rules) — when regenerating with a bumped generator,
re-diff its manifest against ours for new dependencies.

**User-agent:** static `gemina-sdk-<lang>` via `httpUserAgent` where the
generator supports it (server-side languages); the hand-written client facade
upgrades it to `gemina-sdk-<lang>/<package-version>`. TypeScript sends no
custom UA (browsers forbid overriding it).

**Spec pipeline note:** the poll endpoint's 202-with-body branch is *declared*
in the spec (gemina-api-v2 PR #199) — that is what lets every generated client
deserialize in-flight poll responses. If a regenerated client suddenly returns
null from polling, check that the frozen spec still declares 202.
