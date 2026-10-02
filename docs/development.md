# Maintaining OMPilot

`main` is the maintained fork branch. `origin` points to the OMPilot fork and `upstream` to Chakyiu/omp-vscode. The upstream MIT license remains intact.

Use Bun 1.3.14 and Node 24 in WSL. Install with `bun install --frozen-lockfile`, then run `bun run compile`, `bun run test`, and `bun run package`. Normal tests use process fixtures and do not call providers. Live smoke tests are opt-in.

The initial release passed 104 automated checks and the real-OMP checks listed in [verification](verification.md). Cursor desktop interaction still needs manual verification in a WSL window.

## Enable GitHub Actions

The publishing account's existing GitHub CLI token has repository access but lacks `workflow` scope. GitHub rejected a push containing a workflow. The tested workflow is preserved as `docs/ci-workflow.yml`; no automated CI run is active yet.

If you want to enable it, run the following from this checkout in WSL. The authentication refresh needs you to complete GitHub's browser authorization.

```bash
gh auth refresh --hostname github.com --scopes workflow
mkdir -p .github/workflows
cp docs/ci-workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "Enable OMPilot verification workflow"
git push origin main
```

The workflow installs frozen dependencies, compiles, runs tests, builds a VSIX, and uploads it as a build artifact. It does not access OMP credentials or send model requests.
