# Releasing

markdown-twain is published to the Visual Studio Marketplace as `mcdp-adk.markdown-twain`. CI builds each version's VSIX and attaches it to a GitHub Release; the maintainer uploads that VSIX to the Marketplace by hand.

Uploads are manual because Azure DevOps personal access tokens, which `vsce publish` uses, [stop working on 2026-12-01](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/), and Marketplace [trusted publishing](https://github.com/microsoft/vscode-vsce/issues/1275) is not yet available.

## Release a version

1. In a pull request, bump `version` in `package.json` and add an entry for it to `CHANGELOG.md`. Merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git fetch origin
   git tag v<version> origin/main
   git push origin v<version>
   ```

3. The tag's CI run repeats the checks, then the `release` job packages the extension and creates a GitHub Release for the tag with the VSIX attached. The job fails without packaging if the tag isn't `v` followed by the manifest version, and fails without changing anything if a Release for the tag already exists.
4. Download the VSIX from the Release:

   ```sh
   gh release download v<version> --pattern '*.vsix'
   ```

5. Open the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/mcdp-adk), open the menu next to markdown-twain, choose **Update**, and upload the VSIX. The first version is uploaded with **New extension** > **Visual Studio Code** instead.

To fix a version that is already uploaded, release a new patch version rather than replacing its Release.

## Build a VSIX from source

Install Node.js 22 and pnpm 12.6.0, then run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm package
```

`pnpm package` builds the extension and writes `markdown-twain-<version>.vsix` in the repository root. Install it with `code --install-extension ./markdown-twain-<version>.vsix`, or select **Install from VSIX...** in VS Code's Extensions view.
