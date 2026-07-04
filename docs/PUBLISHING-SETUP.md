# Registry Publishing Setup — Operator Checklist

One-time account/token setup for publishing the Gemina SDKs. Work top-to-bottom;
**start with Maven Central** — its DNS namespace verification is the only step with
a real waiting period.

When a token is ready, add it to `~/.gemina-sdk-publish.env` (see the last section)
— the executor picks it up from there and also mirrors it into GitHub Actions
secrets on `tommyil/gemina-sdk`.

Package names (locked 2026-07-04): npm `@gemina/sdk` + `@gemina/elements`,
PyPI `gemina`, NuGet `Gemina.Sdk`, Maven `co.gemina:gemina-sdk`, Packagist `gemina/sdk`.

---

## 1. Maven Central (Sonatype Central Portal) — START FIRST

1. Sign up at <https://central.sonatype.com> (top-right → Sign In → Sign Up; Google/GitHub login works).
2. Once logged in: avatar → **View Namespaces** → **Add Namespace** → enter `co.gemina`.
3. The portal shows a **verification key** (a random string) and asks you to prove
   domain ownership: add a **DNS TXT record** on `gemina.co` (Cloudflare dashboard →
   gemina.co zone → DNS → Add record):
   - Type: `TXT`
   - Name: `@` (the apex, `gemina.co`)
   - Content: the verification key exactly as shown
4. Back in the portal, click **Verify Namespace**. Usually verifies within minutes
   once DNS propagates; can take longer.
5. After verification: avatar → **View Account** → **Generate User Token**.
   You get a **username + password pair** (not your login credentials).
6. Record in the env file as `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD`.

> GPG signing (required by Maven Central) is handled by the executor — a dedicated
> release signing key will be generated and its public part pushed to the keyservers.
> Nothing for you to do here.

## 2. npm (`@gemina/sdk`, `@gemina/elements`)

1. Log in (or sign up) at <https://www.npmjs.com>.
2. Create the org that owns the scope: avatar → **Add Organization** →
   name `gemina` → the **free** (public packages) plan.
   - If the name `gemina` is already taken by another user/org, stop and report back —
     we'll pick a fallback scope together (e.g. `@gemina-ai`).
3. Create a token: avatar → **Access Tokens** → **Generate New Token** →
   **Granular Access Token**:
   - Packages and scopes: **Read and write**, scope it to the `gemina` org
     (or "All packages" if org scoping isn't offered before packages exist)
   - Organizations: no access needed
   - Expiry: your call (365 days is fine; we rotate at release cadence)
   - **Bypass 2FA for automation**: enable, otherwise CI publishes will fail
4. Record as `NPM_TOKEN` (starts with `npm_`).

## 3. PyPI (`gemina`)

1. Sign up at <https://pypi.org> and enable 2FA (mandatory for new accounts).
2. Account settings → **API tokens** → **Add API token**:
   - Name: `gemina-sdk-publish`
   - Scope: **Entire account** — required because the `gemina` project doesn't exist
     yet; after the first upload you may replace it with a project-scoped token.
3. Record as `PYPI_TOKEN` (starts with `pypi-`).

## 4. NuGet (`Gemina.Sdk`)

1. Sign in at <https://www.nuget.org> (Microsoft account).
2. Avatar → **API Keys** → **Create**:
   - Key name: `gemina-sdk-publish`
   - Package owner: your account
   - Scopes: **Push** → *Push new packages and package versions*
   - Glob pattern: `Gemina.*`
3. Record as `NUGET_API_KEY`.

## 5. Packagist (`gemina/sdk`)

1. Sign up at <https://packagist.org> — **use "Login with GitHub"** (enables automatic
   update webhooks on the repo).
2. Profile page → **Show API Token** → record as `PACKAGIST_TOKEN`, and record your
   Packagist username as `PACKAGIST_USERNAME`.
3. Nothing to submit yet — the executor will create the PHP read-only mirror repo
   (Packagist can't index a package from a monorepo subdirectory) and submit it;
   the vendor name `gemina` is claimed by that first submission.

---

## Handing the tokens to the executor

Create the file below **outside any git repo**, then tell the executor it's ready:

```bash
touch ~/.gemina-sdk-publish.env && chmod 600 ~/.gemina-sdk-publish.env
```

Fill it in `KEY=VALUE` form (no quotes, no export):

```
NPM_TOKEN=npm_xxx
PYPI_TOKEN=pypi-xxx
NUGET_API_KEY=xxx
MAVEN_CENTRAL_USERNAME=xxx
MAVEN_CENTRAL_PASSWORD=xxx
PACKAGIST_USERNAME=xxx
PACKAGIST_TOKEN=xxx
```

Partial is fine — add keys as they become ready; the executor publishes to each
registry as its credential appears and loudly skips the ones still missing.
