# Registry Publishing Setup — Operator Checklist

Account setup for publishing the Gemina SDKs. npm uses a GitHub trusted publisher;
the other registries use the credentials below. Work top-to-bottom;
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

Both packages already exist under the `gemina` scope. The release workflow uses
GitHub's identity through npm trusted publishing, rather than `NPM_TOKEN`.

1. Sign in at <https://www.npmjs.com> with an account that can publish both packages.
2. Under profile → Account, enable two-factor authentication with your own passkey
   or security key. Keep the recovery codes in your normal password manager.
3. Open each package's Settings → Trusted publishing and add a GitHub Actions
   publisher with these exact values:
   - Organization or user: `tommyil`
   - Repository: `gemina-sdk`
   - Workflow filename: `release.yml`
   - Environment name: leave empty
   - Allowed action: enable **Allow npm publish**. Stage-only permission does not
     authorize the workflow's direct publish command.
4. Create both publishers immediately before the next version-tag release. A tag
   push is this workflow's only trigger and releases the SDKs together. Complete
   the first successful publication within npm's two-day validation window.
   Confirm both actual package versions in the registry; a GitHub release page
   alone is not proof that the publish jobs succeeded.
5. After both trusted publications are verified, delete the unused `NPM_TOKEN`
   GitHub secret and remove its line from the local publishing env file. Revoke
   any superseded npm automation token that is still active. Keep other registry
   credentials intact.

The workflow runs on GitHub-hosted runners, grants `id-token: write` only to the
npm jobs, and uses npm 11.21.1 on Node 22. No npm token is needed in the env file
or GitHub secrets for these jobs.

If an npm job returns 401 or 404, first check the trusted publisher's exact repo,
workflow filename, allowed publish action and validation window. A failed identity
exchange can fall back to the placeholder token from `setup-node`, which makes
the registry error look like a token problem. A local `npm login` does not repair
the GitHub publisher configuration.

An immutable tag created before this workflow change still contains its original
workflow. Do not move or recreate it. A maintainer may recover its unpublished
packages with an interactive, 2FA-authenticated `npm publish` from the exact tag:
publish the SDK first, then elements. Verify registry artifacts against the built
package. That does not change the historical workflow's result or count as a
trusted-publisher validation run.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm's account 2FA setup](https://docs.npmjs.com/configuring-two-factor-authentication/).

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
PYPI_TOKEN=pypi-xxx
NUGET_API_KEY=xxx
MAVEN_CENTRAL_USERNAME=xxx
MAVEN_CENTRAL_PASSWORD=xxx
PACKAGIST_USERNAME=xxx
PACKAGIST_TOKEN=xxx
```

Partial is fine — add keys as they become ready; the executor publishes to each
registry as its credential appears and loudly skips the ones still missing.
