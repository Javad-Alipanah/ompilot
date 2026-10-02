import * as vscode from "vscode";
import { ChatViewProvider } from "./chat/chatViewProvider";
import { disposeErrorLog, initErrorLog, logError, showErrorLog } from "./omp/errorLog";
import { invalidateOmpModelCache, preloadOmpModels } from "./omp/modelCatalog";
import {
  overridesBeforeSwitch,
  type ProfileOverrides,
  pickerOverrides,
  profileOverrideKeys,
} from "./omp/profileOverrides";
import {
  listProfileContexts,
  type OmpProfileContext,
  resolveProfileContext,
  stripLaunchContextArgs,
  stripProfileArgs,
} from "./omp/profiles";
import { resolveOmpPath } from "./omp/runtimePath";
import { setTitleExtensionRoot } from "./omp/sessionManager";
import { type OpenSessionsState, TabManager } from "./omp/tabManager";
import { terminalCapture } from "./omp/terminalCapture";
import { disposeToolFileLog, showToolFileLog } from "./omp/toolFileLog";

function workspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? process.cwd();
}

const OPEN_SESSIONS_KEY = "ompChat.openSessions";
const LEGACY_LAST_SESSION_KEY = "ompChat.lastSessionId";
let shutdownSessions: (() => Promise<void>) | undefined;

function readOpenSessions(context: vscode.ExtensionContext): OpenSessionsState | undefined {
  const saved = context.workspaceState.get<OpenSessionsState>(OPEN_SESSIONS_KEY);
  const rawIds = saved?.sessionIds ?? [];
  const sessionIds: string[] = [];
  const titles: string[] = [];
  for (let i = 0; i < rawIds.length; i += 1) {
    const id = rawIds[i]?.trim();
    if (!id) {
      continue;
    }
    sessionIds.push(id);
    titles.push(saved?.titles?.[i]?.trim() || "New chat");
  }
  if (sessionIds.length > 0) {
    return {
      sessionIds,
      titles,
      activeIndex: Math.min(Math.max(saved?.activeIndex ?? 0, 0), sessionIds.length - 1),
    };
  }

  // Migrate the older single-session key so existing workspaces keep restoring.
  const legacy = context.workspaceState.get<string>(LEGACY_LAST_SESSION_KEY);
  if (legacy?.trim()) {
    return { sessionIds: [legacy.trim()], titles: ["New chat"], activeIndex: 0 };
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  initErrorLog(context);
  setTitleExtensionRoot(context.extensionPath);
  terminalCapture.start();
  context.subscriptions.push(terminalCapture);

  const desiredProfile = () => {
    const config = vscode.workspace.getConfiguration("ompChat");
    return resolveProfileContext({
      profile: config.get<string>("profile", ""),
      extraArgs: config.get<string[]>("extraArgs", []),
      cwd: workspaceCwd(),
    });
  };
  let currentProfile = desiredProfile();
  const readOverrides = (): ProfileOverrides => {
    const config = vscode.workspace.getConfiguration("ompChat");
    return {
      model: config.get<string>("model", ""),
      thinking: config.get<string>("thinking", ""),
      approvalMode: config.get<string>("approvalMode", ""),
      autoApprove: config.get<boolean>("autoApprove", false),
    };
  };
  const overridesKey = (profile: OmpProfileContext) => `ompChat.profileOverrides:${profile.key}`;
  let boundOverrides = readOverrides();
  const editableConfigs = (profile: OmpProfileContext) => [
    ...new Set([profile.configFile, profile.projectConfigFile, ...profile.overlayConfigPaths]),
  ];
  const storeFor = (profile: OmpProfileContext) => {
    const key = `${OPEN_SESSIONS_KEY}:${profile.key}`;
    return {
      get(): OpenSessionsState | undefined {
        return (
          context.workspaceState.get<OpenSessionsState>(key) ??
          (profile.profile ? undefined : readOpenSessions(context))
        );
      },
      set(state: OpenSessionsState): void {
        void context.workspaceState.update(key, state);
      },
    };
  };
  const runtimeOptions = (profile: OmpProfileContext) => ({
    cwd: profile.cwd,
    profile: profile.profile ?? "default",
    extraArgs: stripLaunchContextArgs(
      vscode.workspace.getConfiguration("ompChat").get<string[]>("extraArgs", []),
    ),
  });
  const sessions = new TabManager(
    workspaceCwd,
    storeFor(currentProfile),
    runtimeOptions(currentProfile),
  );
  let shutdown: Promise<void> | undefined;
  shutdownSessions = () => (shutdown ??= sessions.dispose());
  const provider = new ChatViewProvider(
    context.extensionUri,
    sessions,
    context.globalStorageUri,
    () => currentProfile,
  );

  let applying: Promise<void> | undefined;
  const assertIdle = () => {
    if (sessions.getTabs().some((tab) => tab.busy || tab.status === "starting"))
      throw new Error(
        "Wait for OMP work to settle or stop it before switching profiles or applying startup config.",
      );
  };
  const applyConfig = async (restoreProfileChoices = false) => {
    if (applying) return applying;
    assertIdle();
    const next = desiredProfile();
    const previous = currentProfile;
    applying = (async () => {
      const current = readOverrides();
      await context.workspaceState.update(
        overridesKey(previous),
        overridesBeforeSwitch(
          previous.key,
          next.key,
          current,
          boundOverrides,
          restoreProfileChoices,
        ),
      );
      if (restoreProfileChoices) {
        const restored = pickerOverrides(
          previous.key,
          next.key,
          current,
          context.workspaceState.get<ProfileOverrides>(overridesKey(next)),
        );
        const config = vscode.workspace.getConfiguration("ompChat");
        for (const key of profileOverrideKeys) {
          if (current[key] !== restored[key])
            await config.update(key, restored[key], vscode.ConfigurationTarget.Workspace);
        }
      }
      const targetOverrides = readOverrides();
      await context.workspaceState.update(overridesKey(next), targetOverrides);
      assertIdle();
      boundOverrides = targetOverrides;
      currentProfile = next;
      await sessions.switchRuntime(storeFor(next), runtimeOptions(next));
    })().finally(() => {
      applying = undefined;
    });
    await applying;
    invalidateOmpModelCache();
    void preloadOmpModels(
      resolveOmpPath(vscode.workspace.getConfiguration("ompChat").get<string>("ompPath", "omp")),
      next.profile ?? "default",
    );
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.applyConfig", () => applyConfig()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.pickProfile", async () => {
      assertIdle();
      const profiles = await listProfileContexts({ cwd: workspaceCwd() });
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: "Automatic",
            description: "Use launch arguments or OMP_PROFILE, otherwise default",
            value: "",
          },
          { label: "Default", description: "Explicitly use the base profile", value: "default" },
          ...profiles
            .filter((profile) => profile.profile)
            .map((profile) => ({
              label: profile.label,
              description: profile.configFile,
              value: profile.profile!,
            })),
        ],
        { title: "OMP profile", placeHolder: `Active: ${currentProfile.label}` },
      );
      if (!selected) return;
      assertIdle();
      const config = vscode.workspace.getConfiguration("ompChat");
      if (selected.value)
        await config.update(
          "extraArgs",
          stripProfileArgs(config.get<string[]>("extraArgs", [])),
          vscode.ConfigurationTarget.Workspace,
        );
      await config.update("profile", selected.value, vscode.ConfigurationTarget.Workspace);
      await applyConfig(true);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.openConfig", async () => {
      const paths = editableConfigs(currentProfile);
      const selected = await vscode.window.showQuickPick(
        paths.map((file) => ({
          label:
            file === currentProfile.configFile
              ? "Active profile config"
              : file === currentProfile.projectConfigFile
                ? "Project config"
                : "Config layer",
          description: file,
          file,
        })),
        { title: `Edit OMP config · ${currentProfile.label}` },
      );
      if (!selected) return;
      const uri = vscode.Uri.file(selected.file);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound")
          throw error;
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
        await vscode.workspace.fs.writeFile(uri, Buffer.from("# OMP configuration overrides\n"));
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (editableConfigs(currentProfile).includes(document.uri.fsPath))
        vscode.window.setStatusBarMessage(
          "OMP watches YAML changes. For startup settings, use OMP: Apply Config to Sessions after work settles.",
          8000,
        );
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.open", async () => {
      await vscode.commands.executeCommand("ompChat.sidebar.focus");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.diagnostics", async (show = true) => {
      await sessions.ensureStarted();
      const session = sessions.active();
      await session.refreshSessionState();
      await session.refreshInspection();
      const report = {
        platform: process.platform,
        remote: vscode.env.remoteName ?? null,
        workspace: workspaceCwd(),
        ompPath: resolveOmpPath(
          vscode.workspace.getConfiguration("ompChat").get<string>("ompPath", "omp"),
        ),
        status: session.getStatus(),
        model: session.getModelLabel(),
        sessionId: session.getSessionId(),
        inspectorError: session.getInspection().error ?? null,
        profile: currentProfile.label,
        profileSource: currentProfile.source,
        configFile: currentProfile.configFile,
        configLayers: editableConfigs(currentProfile),
        sessionStorage: currentProfile.sessionsDir,
        observedSessionFile: session.getSessionFile(),
        ompWorkingDirectory: currentProfile.cwd,
        configuredProfile: desiredProfile().label,
      };
      if (show) {
        const document = await vscode.workspace.openTextDocument({
          language: "json",
          content: JSON.stringify(report, null, 2),
        });
        await vscode.window.showTextDocument(document, { preview: true });
      }
      return report;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.showToolLog", () => {
      showToolFileLog();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.showErrorLog", () => {
      showErrorLog();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.newChat", async () => {
      await provider.newChat();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.stop", () => {
      provider.stop();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.restartSession", async () => {
      await provider.restart();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachFiles", async () => {
      await provider.attachFiles();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachFolder", async () => {
      await provider.attachFolder();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachMenu", async () => {
      await provider.showAttachMenu();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ompChat.attachExplorer",
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = uris?.length ? uris : uri ? [uri] : [];
        if (!selected.length) {
          await provider.attachFiles();
          return;
        }
        await provider.attachPaths(selected.map((item) => item.fsPath));
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachTerminal", async () => {
      await provider.attachTerminal();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage("Select some code first.");
        return;
      }
      const selection = editor.document.getText(editor.selection);
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const language = editor.document.languageId;
      sessions.addAttachment({
        kind: "selection",
        label: `${rel} (selection)`,
        path: rel,
        language,
        content: selection,
      });
      await vscode.commands.executeCommand("ompChat.sidebar.focus");
      provider.revealAttachments();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ompChat.attachCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Open a file first.");
        return;
      }
      const fileUri = editor.document.uri;
      const rel = vscode.workspace.asRelativePath(fileUri);
      if (fileUri.scheme === "file" && !editor.document.isDirty) {
        sessions.addAttachment({
          kind: "file",
          label: rel,
          path: rel,
          fsPath: fileUri.fsPath,
          language: editor.document.languageId,
        });
      } else {
        sessions.addAttachment({
          kind: "text",
          label: rel,
          path: rel,
          language: editor.document.languageId,
          content: editor.document.getText(),
        });
      }
      await vscode.commands.executeCommand("ompChat.sidebar.focus");
      provider.revealAttachments();
    }),
  );

  context.subscriptions.push(provider);
  context.subscriptions.push({
    dispose: () => {
      void shutdownSessions?.();
      disposeToolFileLog();
      disposeErrorLog();
    },
  });

  void sessions.ensureStarted().catch((err) => {
    logError("Failed to start omp session on activate", err);
  });

  // Preload the model list once at startup so the picker opens instantly;
  // `ompChat.newChat`/session-ready refresh keeps it fresh. Reload if the
  // omp binary path changes, since the cache is keyed on it.
  const preloadModels = () => {
    const ompPath =
      vscode.workspace.getConfiguration("ompChat").get<string>("ompPath", "omp") || "omp";
    void preloadOmpModels(ompPath, currentProfile.profile ?? "default").catch(() => {
      // Non-fatal: the picker falls back to a fresh fetch on miss.
    });
  };
  preloadModels();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !applying &&
        profileOverrideKeys.some((key) => e.affectsConfiguration(`ompChat.${key}`)) &&
        desiredProfile().key === currentProfile.key
      )
        boundOverrides = readOverrides();
      if (e.affectsConfiguration("ompChat.ompPath")) {
        invalidateOmpModelCache();
        preloadModels();
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await shutdownSessions?.();
  shutdownSessions = undefined;
}
