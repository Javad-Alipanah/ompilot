# Profiles and configuration

The profile pill and **OMP: Connection Diagnostics** identify the active profile, its config layers, session storage, and the profile currently requested by extension settings. Selection is scoped to the Cursor workspace; separate workspaces can use different profiles.

Selection follows `ompChat.profile` when nonblank; otherwise a real `--profile` in `ompChat.extraArgs`, then inherited `OMP_PROFILE`/`PI_PROFILE`, then OMP's default. `default` explicitly selects the base profile even when the environment names another profile. A conflicting explicit setting and launch flag is rejected. The picker removes old profile flags when choosing an explicit profile. Blank **Automatic** honors the inherited launch context.

Named profiles have separate settings, authentication databases, sessions, and caches. No authentication database is copied from the default profile. Inherited environment credentials, home/project dotenv credentials, or a shared auth broker can still be used across profiles; profiles are not a credential firewall. Existing profiles appear in the picker; a manually configured new profile follows OMP's creation behavior and may need its own authentication. Each profile keeps its own open-tab set. Switching never resumes the previous profile's session IDs under the new profile.

The **Profile picker** also remembers model, thinking, approval mode, and auto-approve extension overrides for each profile in this workspace. A profile used for the first time starts with those overrides blank/off so OMP can choose its configured defaults. Selecting the same effective profile preserves its current choices. If you edit `ompChat.profile` and other workspace settings manually, **Apply config** treats those current settings as explicit choices for the requested profile. Extra launch flags remain workspace-wide and can still override a profile's YAML. Restored conversations may retain their recorded model/thinking state.

The extension resolves common OMP directories, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, XDG paths, and explicit session/config arguments. OMP can also load directory variables from profile dotenv files. Those files remain owned by OMP; the extension does not inspect their credentials. Diagnostics include the observed RPC session, while displayed configuration/storage paths describe the resolved launch context.

| Change | When it applies |
| --- | --- |
| Main thinking visibility | Immediately, including an active stream |
| Ask/Plan interaction preference | The next composed prompt; it is an instruction, not a permission boundary |
| Valid global/project/overlay YAML | OMP watches and reloads it live; runtime/CLI overrides retain precedence |
| Advisor/prewalk YAML settings | OMP reconciles them live; existing prewalk state can affect whether it can arm |
| Advisor on/off and Arm prewalk buttons | Runtime-only commands; they do not save YAML and reset to configured behavior on a process restart |
| Model-role YAML | Future role resolution and advisor behavior; the current main model stays pinned |
| Main model picker | Restarts the selected idle session with an explicit model override |
| Default thinking/model changes | Use Apply config/new sessions; current or restored session state may retain its selected model/thinking |
| Named profile, startup plugins/resources, launch flags | Apply config restarts OMP; saved chats remain in their own profile |
| Environment exported in an unrelated terminal | Does not change an existing Cursor extension host; reconnect/reload the WSL window if you need its inherited environment refreshed |
| Extension update | Reload the Cursor window once |

**Config** opens YAML directly in the editor. Saving does not automatically stop active work. **Apply config** restarts all settled tabs with the selected launch configuration; it is disabled/rejected when any tab is starting or working. Stop work or wait before applying. During live reload, invalid YAML keeps the previous in-memory settings; check OMP warnings/logs. A fresh process cannot recover those in-memory values and may fail or quarantine an invalid file and use fallback settings. Repair YAML before restarting. Connection Diagnostics identifies paths and process state; it is not a YAML validator.

Profile switching discards unsent composer/attachment drafts from the old tab set. Send or copy those drafts first. Saved OMP conversations remain available. The built-in Cursor chat is a separate conversation system.
