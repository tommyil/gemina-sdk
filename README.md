# Gemina SDKs

Official API client SDKs for the [Gemina](https://gemina.co) Invoice OCR &
Document Intelligence API — generated from the live OpenAPI spec — plus the
embeddable browser UI library `@gemina/elements`.

| Language   | Package                                        | Registry      | Directory          |
|------------|------------------------------------------------|---------------|--------------------|
| TypeScript | [`@gemina/sdk`](https://www.npmjs.com/package/@gemina/sdk) | npm           | `sdks/typescript/` |
| Python     | [`gemina`](https://pypi.org/project/gemina/)   | PyPI          | `sdks/python/`     |
| C#         | [`Gemina.Sdk`](https://www.nuget.org/packages/Gemina.Sdk) | NuGet         | `sdks/csharp/`     |
| Java       | [`co.gemina:gemina-sdk`](https://central.sonatype.com/artifact/co.gemina/gemina-sdk) | Maven Central | `sdks/java/`       |
| PHP        | [`gemina/sdk`](https://packagist.org/packages/gemina/sdk) | Packagist     | `sdks/php/`        |
| Browser UI | [`@gemina/elements`](https://www.npmjs.com/package/@gemina/elements) | npm           | `packages/elements/` |

Each SDK directory has its own README with a quickstart. The headline flow in
every language is the **async one-call helper**: submit a document for
processing and get the typed result back — submit + poll handled for you.

## Architecture

```
gemina-api-v2 /openapi.json          single source of truth
        │  tools/fetch_spec.py       freeze an immutable snapshot
        ▼
specs/gemina-<version>.json          committed, never edited
        │  tools/generate.py         openapi-generator (pinned, via Docker)
        ▼
sdks/<language>/…/generated/         wiped + regenerated, never hand-edited
        +
hand-written helpers per language    async submit+poll convenience layer
        +
packages/elements/                   hand-written React UI (chat, …)
```

**Rules of the repo**

- Generated directories carry a `GENERATED — DO NOT EDIT` banner. Never patch
  them by hand: fixes go into `config/` (generator config / templates), the
  upstream spec, or the hand-written helper layer.
- Regeneration is destructive: `tools/generate.py` wipes each generated dir and
  regenerates from the frozen spec. Regenerating from an unchanged spec must
  produce a zero diff (CI enforces this).
- Hand-written code lives only in each package's helper module and in
  `packages/elements/`.

## Working on this repo

```bash
conda create -n gemina-sdk python=3.12   # once
conda activate gemina-sdk                # tooling is stdlib-only; Docker required

python tools/fetch_spec.py --base-url https://api.gemina.co   # freeze a new spec
python tools/generate.py                 # regenerate every SDK from specs/CURRENT
python tools/generate.py --lang python   # just one
python tools/generate.py --check         # CI mode: regen + assert zero diff
python tools/smoke.py --lang typescript  # build + live smoke call per language
```

Per-language builds run in Docker (or native toolchains in CI) — you don't need
Node/.NET/JDK/PHP installed locally.

## Releasing

Tag `vX.Y.Z` → GitHub Actions regenerates from the frozen spec, builds all
packages, and publishes to every registry whose credential secret is
configured (missing ones are skipped loudly). Each release records the spec
snapshot it was built from. SDK versions are semver, independent of the API
version.

## License

[MIT](LICENSE)
