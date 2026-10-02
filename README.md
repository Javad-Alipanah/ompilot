# OMPilot

[Oh My Pi](https://omp.sh/) inside Cursor, using your existing OMP runtime and provider setup. OMPilot adds a separate chat panel with session tabs, worker controls, advisor transcripts, and prewalk notices.

Repository: [javad-alipanah/ompilot](https://github.com/javad-alipanah/ompilot). Forked from [Chakyiu/omp-vscode](https://github.com/Chakyiu/omp-vscode), under the [MIT license](LICENSE).

## Install in Windows Cursor with WSL

1. Confirm that `omp` works in your WSL terminal with your usual provider configuration. This bridge was verified against **OMP 18.4.10**.
2. Open your project in Cursor, then run **WSL: Reopen Folder in WSL** from the Command Palette. Cursor's WSL support must be installed and connected.
3. Download the VSIX from [Releases](https://github.com/javad-alipanah/ompilot/releases/latest). In that WSL window, run **Extensions: Install from VSIX…** and select it. Check the Extensions view: OMPilot should be installed in the WSL extension host; use **Install in WSL** if it is installed only locally. Reload the window once after installation.
4. Run **OMP: Open Chat** from the Command Palette, or open the **OMPilot** activity bar icon.
5. Send a prompt. If the extension cannot find OMP, set `ompChat.ompPath` in the WSL window to its Linux executable path, such as `/home/you/.bun/bin/omp`, then run **OMP: Restart Session**.

OMPilot runs OMP in WSL when the workspace extension host runs there. Installing the VSIX in a Windows-only window does not make a Linux OMP executable available to that host. Existing OMP credentials and configuration remain in OMP's normal locations; no migration is required.

## Use

- **Main chat:** streaming replies, provider-exposed thinking, and expandable tool cards with complete arguments and output. Each tab has its own OMP process and session. History can resume workspace sessions; open session IDs restore after editor reloads. Right-click a tab to rename, view, copy, or export its conversation as plain text.
- **Direction and stopping:** while the main agent is busy, **Enter** queues a follow-up and **Steer** sends an immediate direction. **Stop** aborts the current turn. Queued follow-ups are retained and run after OMP settles; remove them from the queue if you do not want them sent.
- **Workers:** select a worker in the agent inspector to read its full conversation and raw messages. Running workers expose **Send direction** and **Cancel worker**. **Copy** and **Export** include the complete fetched transcript; Export opens JSON in an editor so you can save it.
- **Advisors and prewalk:** inspect read-only advisor transcripts; use **Advisor on**, **Advisor off**, **Advisor status**, or **Arm prewalk**. Workflow notices show OMP's reported progress and model handoffs. These controls use your OMP workflow configuration.
- **Questions and approvals:** OMP confirmation, choice, text, editor, and structured multi-question dialogs appear above the chat. Structured questions support multiple selections and custom answers. Approval behavior follows OMP settings and any explicit extension overrides.
- **Editor context:** attach a selection, current file, files, folders, images, or captured terminal output. Use the editor or Explorer context menu, the paperclip, or `@` autocomplete. Choosing a dirty **Current file** or open editor from autocomplete attaches its current buffer text. Explicit dirty-file attachments do the same.
- **Profiles and config:** the profile pill shows the active OMP profile. **OMP: Select Profile** switches the workspace and restores that profile's own tabs; it preserves the previous profile's history. **Config** opens profile, project, or launch-overlay YAML in the editor. **Apply config** restarts settled OMP sessions without restarting Cursor. Switching/applying is blocked while any tab is working.
- **Changes:** **Review changes** opens Source Control for the working-tree diff. Tool file links open affected files and known line ranges; **OMP: Show File Touch Log** lists reported edit/write/delete paths.

OMP filesystem tools operate on saved files. A dirty-buffer attachment supplies current editor text as context; it does not save the file or replace the contents on disk. Terminal attachments require editor shell integration and a captured command.

## Settings

The existing `ompChat.*` setting names and `OMP:` commands are retained for compatibility.

| Setting | Behavior |
| --- | --- |
| `ompChat.profile` | Blank inherits launch arguments/environment; `default` forces the base profile; a name selects an isolated profile |
| `ompChat.ompPath` | OMP executable; default `omp`, with common user installation paths checked |
| `ompChat.model` | Optional model override; blank preserves OMP's configured choice |
| `ompChat.thinking` | Optional thinking-level override; blank preserves OMP settings |
| `ompChat.approvalMode` | Optional approval-mode override |
| `ompChat.autoApprove` | Explicitly passes `--auto-approve` when enabled; default off |
| `ompChat.continueLastSession` | Restore open session tabs; default on |
| `ompChat.autoTitle` | Load the bundled session-title extension; default on |
| `ompChat.extraArgs` | Additional arguments for the launched OMP process |
| `ompChat.mode` | Agent / Ask / Plan interaction preference |
| `ompChat.showThinking` | Show thinking blocks that the provider exposes |
| `ompChat.logFileTouches` | Log reported file changes |

Agent / Ask / Plan are prompt hints, not an enforced tool permission boundary or security sandbox. Use OMP's approval configuration for tool approvals. Launch flags can override settings for this process; OMPilot does not rewrite your OMP configuration.

OMP 18.4.10 watches global, project, and `--config` YAML live. Advisor/prewalk settings and future role choices can react to saved changes. Invalid live edits retain the process's previous settings; repair them before restarting, because a fresh process may fail or use fallback settings. Check OMP warnings/logs. Runtime and launch overrides can mask file edits. A running main model is not replaced simply by changing a default model role; use the model picker. Profile/startup-loaded resources require restarting OMP, which **Apply config** does after work settles. Refreshing an already-running extension host's inherited environment can require reconnecting/reloading Cursor. See [profile/config behavior](docs/profiles.md).

## Scope and verification

OMPilot uses its own panel and OMP RPC process. Cursor's built-in Agent runtime is not exposed through a supported replacement interface used by this extension. Native Cursor conversation storage, checkpoints, per-turn revert, and its agent panel are separate systems. **Review changes** shows the current SCM diff, not native per-turn checkpoints.

Live checks against OMP 18.4.10 exercised RPC negotiation, worker transcripts and steering, cancellation acknowledgement and lifecycle, advisor sidecars, exact-session resume, structured questions, tool approval, and prewalk handoff. All 104 automated host/backend and webview DOM tests pass. The native Cursor window was not visually verified during this build. See [verification details](docs/verification.md) and [architecture notes](docs/architecture.md).

## Develop and package

Run these commands in WSL with Bun, a compatible Node.js runtime, and GitHub CLI installed. The RPC process fixtures use Linux executable scripts.

```bash
gh repo clone javad-alipanah/ompilot
cd ompilot
bun install
bun run compile
bun run test
bun run build
bun run package
```

Packaging produces `ompilot-<version>.vsix`. Press **F5** in the repository to launch an Extension Development Host. Live smoke scripts require a working OMP installation and use provider requests; they are separate from `bun run test`.

For connection failures, check the WSL host and executable path first, then run **OMP: Show Error Log**. Use **OMP: Restart Session** after changing runtime arguments. OMPilot keeps the upstream MIT license and attribution.

See [maintenance and CI setup](docs/development.md). The initial publishing token lacks GitHub's workflow scope, so CI is supplied as a template; the release checks were run locally.
