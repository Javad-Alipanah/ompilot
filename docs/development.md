# Maintaining OMPilot

`main` is the maintained fork branch. `origin` points to the OMPilot fork and `upstream` to Chakyiu/omp-vscode. The upstream MIT license remains intact.

Use Bun 1.3.14 and Node 24 in WSL. Install with `bun install --frozen-lockfile`, then run `bun run compile`, `bun run test`, and `bun run package`. Normal tests use process fixtures and do not call providers. Live smoke tests are opt-in.

The backend runner starts a separate Bun process for each test file. This isolates each suite's mocked VS Code module, whose exports would otherwise depend on test discovery order. The UI suites run in Node's test runner.

Version 0.1.1 passes 130 automated checks and the real-OMP checks listed in [verification](verification.md). Cursor desktop interaction still needs manual verification in a WSL window.

## GitHub Actions

The workflow is enabled at `.github/workflows/ci.yml` for pushes and pull requests. The publishing account's GitHub CLI authorization includes the required `workflow` scope. `docs/ci-workflow.yml` remains a template for other forks.

If another fork needs authorization and workflow setup, run the following from that checkout in WSL. The authentication refresh needs browser authorization.

```bash
gh auth refresh --hostname github.com --scopes workflow
mkdir -p .github/workflows
cp docs/ci-workflow.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "Enable OMPilot verification workflow"
git push origin main
```

The workflow installs frozen dependencies, compiles, runs tests, builds a VSIX, and uploads it as a build artifact. It does not access OMP credentials or send model requests.
