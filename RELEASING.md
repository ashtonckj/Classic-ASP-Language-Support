# Releasing a new version

For the maintainer. It is in `.vscodeignore`, so it is not shipped in the extension.

## Once: the two tokens

Put both in **GitHub → the repo → Settings → Secrets and variables → Actions →
New repository secret**. The names must be exactly these:

| Secret name | Where to get it |
|---|---|
| `VSCE_PAT` | [dev.azure.com](https://dev.azure.com) → your avatar's **User settings** → **Personal access tokens** → **New Token**. Organization: **All accessible organizations**. Scopes: **Custom defined** → **Show all scopes** → **Marketplace: Manage**. |
| `OVSX_PAT` | [open-vsx.org](https://open-vsx.org) → sign in with GitHub → **Settings** → **Access Tokens** → **Generate New Token**. |

The Azure token expires (a year at most). When a release fails with
`TF400813 … not authorized`, make a new one and replace `VSCE_PAT`.

## Every release

1. **Merge your branch into `main`**, with a pull request on GitHub or locally.

2. **Bump the version** in two places, with the same number:
   - `package.json` → `"version": "0.8.0"`
   - `README.md` → the badge, `Marketplace-0.8.0`

3. **Add the CHANGELOG entry** at the top of `CHANGELOG.md` (ask Claude: it knows the house template).

4. **Commit and push `main`:**

   ```bash
   git commit -am "chore: releases v0.8.0"
   ```

   ```bash
   git push origin main
   ```

   The **CI** workflow runs (Actions tab). Wait for the green tick.

5. **Tag it, and push the tag.** This is what publishes:

   ```bash
   git tag v0.8.0
   ```

   ```bash
   git push origin v0.8.0
   ```

   The **Release** workflow checks that the tag matches `package.json`, packages the
   extension once, and publishes it to the VS Code Marketplace and Open VSX. The
   `.vsix` is also kept under the run's **Artifacts**.

6. **Write the GitHub release notes:** Releases → **Draft a new release** → choose the tag →
   paste the notes (ask Claude, same template).

The Marketplace takes a few minutes to show a new version; Open VSX is usually quicker.

## If something goes wrong

- **The tag doesn't match `package.json`:** nothing is published. Delete the tag, fix the version, tag again:

  ```bash
  git tag -d v0.8.0
  ```

  ```bash
  git push origin :refs/tags/v0.8.0
  ```

- **Publishing by hand instead**, from the repo folder (the token is pasted in place of `TOKEN`):

  ```bash
  npx @vscode/vsce publish -p TOKEN
  ```

  ```bash
  npx ovsx publish -p TOKEN
  ```

- **Just a `.vsix` to try or share:** `npx @vscode/vsce package`.
