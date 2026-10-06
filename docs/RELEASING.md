# Releasing Sync Retail (Windows)

Releases are built by GitHub Actions from a version tag (`.github/workflows/release.yml`). The workflow produces a **draft** GitHub Release; a maintainer checks it and publishes it.

## 1. Cut a release

1. **Bump the version** in all of these (they must match; the workflow checks):
   - `package.json`, `frontend/package.json`, `backend/package.json`, `shared/package.json`
   - `frontend/src-tauri/tauri.conf.json`, `frontend/src-tauri/Cargo.toml`
   
   Then run `npm install --package-lock-only` to update the lockfile.
2. **Commit** (`Release x.y.z: …`) and push to `main`. Wait for **CI** to pass.
3. **Tag and push** the tag:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```
   A tag with a hyphen (e.g. `v1.2.0-beta.1`) becomes a pre-release.
4. **Release workflow** (about 15–25 minutes) builds:
   1. `sr-host.exe` (Main Register API + database runtime, branded and with Node's signature stripped), and its resources
   2. the app (`sync-retail.exe`)
   3. the NSIS installer `SyncRetail-<version>-x64-setup.exe` plus `SHA256SUMS.txt`
   
   With signing configured (§2), each of these is signed on the way.
5. **Review the draft release** on GitHub:
   - install the installer on a test PC (over the previous version, to check the data upgrade)
   - edit the generated notes for staff (what changed, in plain words)
   - publish it

To build without releasing (e.g. to test the workflow), run **Release** manually from the Actions tab (*workflow_dispatch*); the installer is kept as a workflow artifact.

## 2. Code signing (SignPath Foundation)

Signing is off until these repository settings exist. Once they're set, the next release is signed automatically; no workflow edits are needed.

| Setting | Where | Value |
|---|---|---|
| `SIGNPATH_API_TOKEN` | Settings → Secrets and variables → Actions → **Secrets** | API token of the SignPath CI user |
| `SIGNPATH_ORGANIZATION_ID` | … → **Variables** | Your SignPath organisation id |
| `SIGNPATH_PROJECT_SLUG` | … → Variables (optional) | defaults to `sync-retail` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | … → Variables (optional) | defaults to `release-signing` |

In SignPath, create the project with two **artifact configurations**, using the files in [`.signpath/artifact-configurations/`](../.signpath/artifact-configurations/):

- `binaries`: signs `sync-retail.exe` and `sr-host.exe` (round 1, before they are packed into the installer)
- `installer`: signs the installer (round 2)

Link the project to this GitHub repository (trusted build system), and require **manual approval** for the release signing policy. Each signing request then waits for a maintainer to approve it in SignPath before the workflow continues.

### Applying to SignPath Foundation

Apply at [signpath.org](https://signpath.org). They look for:
- an OSI-approved licence (AGPL-3.0-only, see `LICENSE`)
- a public repository with recent activity
- release builds from CI (this workflow)
- a code signing policy and privacy statement on the project page (README → *Code signing policy*)

Their requirements change from time to time. Check the current list before applying.

## 3. Not covered yet

- **In-app updates:** see [`OTA_UPDATE_PLAN.md`](OTA_UPDATE_PLAN.md). Once built, the workflow also publishes `latest.json` and the Tauri update signature.
- **The NSIS uninstaller** inside the installer isn't separately signed (it's generated inside the installer build). This is a known gap and doesn't affect installing.
