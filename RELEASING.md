# Releasing

Releases are published from GitHub. Publishing a GitHub Release runs `.github/workflows/release.yml`, which checks the tag, runs the typecheck, build and tests, and publishes to npm with provenance.

## One-time setup

Pick **one** of these two ways to let GitHub Actions publish.

### Option A: trusted publishing (recommended, no secret to manage)

1. Open https://www.npmjs.com/package/llm-json-schema/access, signed in as `buildwithnikhil`.
2. Under **Trusted Publisher**, choose **GitHub Actions** and enter:
   - Organization or user: `buildwithnikhil`
   - Repository: `llm-json-schema`
   - Workflow filename: `release.yml`
   - Environment: leave empty
3. Save.

### Option B: an npm token

1. On npmjs.com, go to **Access Tokens → Generate New Token → Granular Access Token**.
2. Give it **Read and write** access to the `llm-json-schema` package only. Enable **Bypass two-factor authentication**, because Actions can't enter a 2FA code. Set an expiry.
3. In the GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret**, name it `NPM_TOKEN`, and paste the token.

## Each release

Every PR that should ship already bumps `version` in `package.json` and adds a section to `CHANGELOG.md`.

1. **Merge the PR** into `master` (CI must pass).
2. **Check the version:** `master`'s `package.json` has the version you want to release, for example `0.3.0`.
3. **Create the release:** on GitHub, go to **Releases → Draft a new release**.
   - **Tag:** `v0.3.0`, the same as `package.json` with a `v`. Choose "Create new tag on publish", target `master`.
   - **Title:** `v0.3.0`
   - **Notes:** paste that version's section from `CHANGELOG.md`, or click **Generate release notes**.
4. **Click Publish release.**
5. **Watch the Release workflow** under the **Actions** tab. When it's green, check https://www.npmjs.com/package/llm-json-schema.

If the tag and `package.json` don't match, the workflow stops before publishing. Delete the release and its tag, fix the version, and try again.

## Merging a series of stacked PRs

Some changes come as a series of PRs, each one commit stacked on the previous one. Merge them **in order**:

1. Merge the first PR (squash).
2. Open the next PR. If GitHub shows **"This branch is out-of-date"**, click **Update branch → Update with rebase**. Because each PR is a single commit, this applies cleanly.
3. Wait for CI, merge, release, and repeat.
