# Verification for 0.1.2

Checked on 2026-10-02 in Ubuntu WSL with OMP 18.4.10, Bun 1.3.14 and Node 24. The Windows editor is Cursor 3.22.12.

## Automated checks

- TypeScript compilation: passed.
- 92 backend/host tests and 43 webview DOM tests: passed (135 total).
- Biome error-level check and Git whitespace check: passed.
- Frozen dependency installation and production VSIX packaging: passed locally.

GitHub Actions is enabled for pushes and pull requests. The workflow performs frozen installation, compilation, tests and VSIX packaging without OMP credentials or provider calls.

The suite covers RPC framing and process disposal, asynchronous settling and queued prompts, streamed/restored thinking, complete tool outputs, worker/advisor transcript restoration, nested owned-path validation, profile resolution and remembered overrides, custom session directories, editor buffers, questions, stale events and per-tab UI drafts.

Inline slash completion is covered after prose, on later contenteditable lines, with earlier slash tokens, while editing within a token, and with image attachments. Surrounding prompt text stays intact. Slashes within URLs, relative paths and fractions do not trigger the popup. OMP retains responsibility for command invocation syntax.

## Real OMP checks

The baseline checks through 0.1.1 used disposable workspaces and harness-owned sessions to exercise the actual installed runtime. Existing user conversations and configuration were not modified. The 0.1.2 change affects only composer completion and adds DOM regressions; it does not change the OMP transport.

| Check | Observed result |
| --- | --- |
| RPC startup | Version-2 negotiation and request correlation worked |
| Profiles | Three existing profiles launched with their configured models and separate session storage; no prompts were sent for this check |
| Commands/skills | Actual `get_available_commands` returned 167 metadata entries, including 111 skills; the delivered client preserved exact qualified names without sending a model prompt |
| Workers | Worker launch and immediate steering worked; steering appeared in the saved conversation |
| Full child history | Six conversational messages and fifteen entries returned; the next cursor read was empty |
| Resume | Exact parent session resumed; delivered inspector restored child and advisor sidecars |
| Advisor | Actual advisor events and a ten-message advisor transcript observed |
| Questions and approval | Structured answer accepted; explicit tool approval allowed a write in the temporary workspace |
| Prewalk | Actual workflow notices and a configured model handoff observed |
| Worker cancellation | Cancellation acknowledged, worker became aborted, and sibling completed |

The cancellation scenario's parent continuation exceeded its bounded 120-second budget. The harness aborted its own parent and observed settlement. This confirms the worker cancellation lifecycle, not full success of that entire scenario. Nested workers and reasoning integrity have regression coverage; no extra nested provider calls were made.

## Limits and reproduction

The native Cursor panel has not been visually exercised during this build. Command-line installation and automated webview tests do not prove an interactive desktop session. Use **OMP: Connection Diagnostics** after opening the installed panel in a WSL workspace.

The opt-in `scripts/smoke-omp.ts` and `tests/live-omp-backend.ts` exercise real provider calls and delivered transport/inspection code. `tests/live-profiles.ts` performs no-prompt handshakes for discovered profiles (or a comma-separated `--profiles=default,work` selection). These scripts are separate from the normal test suite. Keep their output under ignored `work/`; raw sessions and local configuration are not release assets.

Wire behavior was checked against [OMP's versioned RPC types](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/coding-agent/src/modes/rpc/rpc-types.ts), [RPC dispatcher](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/coding-agent/src/modes/rpc/rpc-mode.ts), [profile directories](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/utils/src/dirs.ts), and [settings implementation](https://github.com/can1357/oh-my-pi/blob/v18.4.10/packages/coding-agent/src/config/settings.ts).
