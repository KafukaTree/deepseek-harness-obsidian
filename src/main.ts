import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TFile,
  TFolder,
  type TAbstractFile,
  type WorkspaceLeaf
} from "obsidian";
import {
  AgentWorkbenchView,
  DSH_AGENT_WORKBENCH_VIEW_TYPE
} from "./companion/agent-workbench-view";
import { FileTreeBridge } from "./companion/file-tree-bridge";
import { startGui, type GuiHandle } from "./companion/gui/gui-boot";
import {
  MainInstanceClient,
  MainInstanceError,
  type SessionSummary,
  type WorkspaceSummary
} from "./companion/main-instance-client";
import {
  DSH_MAIN_SESSION_VIEW_TYPE,
  MainInstanceView
} from "./companion/main-instance-view";
import {
  DEFAULT_SETTINGS,
  DeepSeekHarnessSettingTab,
  type DeepSeekHarnessSettings
} from "./settings";
import {
  addSessionBinding,
  movePathBindings,
  normalizeSessionBindings,
  removePathBindings,
  replaceSessionBinding,
  selectSessionBinding
} from "./state/session-map";
import { SerializedSnapshotWriter } from "./state/serialized-snapshot-writer";
import {
  addStandaloneSessionBinding,
  addStandaloneSessionGroup,
  normalizeStandaloneSessionBindings,
  selectStandaloneSessionBinding,
  type StandaloneSessionGroup
} from "./state/standalone-session-map";
import { targetWorkspacePath } from "./state/workspace-scope";

const MAIN_INSTANCE_URL = "http://127.0.0.1:3080";
const ACTIVE_SETTING_KEYS = new Set([
  "vaultId",
  "sessionsByPath",
  "sessionByPath",
  "targetIdByPath",
  "targetKindByPath",
  "standaloneSessionGroups",
  "activeStandaloneSessionId",
  "standaloneWorkspaceId",
  "openMainSessionOnLoad"
]);

/**
 * The active product shell: Obsidian's native file tree on the left and the
 * native path-free Agent workbench beside it, with the official DSH client
 * mounted in one right-sidebar view. No second runtime or private Agent data
 * plane is started by this entry.
 */
export default class DeepSeekHarnessPlugin extends Plugin {
  settings: DeepSeekHarnessSettings = structuredClone(DEFAULT_SETTINGS);
  private guiInstance: GuiHandle | null = null;
  private guiPromise: Promise<GuiHandle> | null = null;
  private fileTreeBridge: FileTreeBridge | null = null;
  private activePath: string | null = null;
  private migratedConflictPaths = 0;
  private migratedConflictSessions = 0;
  private migratedStandaloneConflicts = 0;
  private standaloneCreatePromise: Promise<void> | null = null;
  private unloaded = false;
  private readonly mainClient = new MainInstanceClient(MAIN_INSTANCE_URL);
  private readonly settingsWriter = new SerializedSnapshotWriter<DeepSeekHarnessSettings>(
    (snapshot) => this.saveData(snapshot)
  );

  async onload(): Promise<void> {
    this.unloaded = false;
    await this.loadSettings();
    if (this.migratedConflictPaths > 0) {
      new Notice(
        `检测到 ${this.migratedConflictPaths} 个旧路径共享 ${this.migratedConflictSessions} 个 DSH 会话，` +
        "已解除歧义绑定；原会话日志未删除，请从各路径重新创建独立会话。",
        12_000
      );
    }
    if (this.migratedStandaloneConflicts > 0) {
      new Notice(
        `检测到 ${this.migratedStandaloneConflicts} 个会话同时属于内容目标和 AI 工作台，` +
        "已保留具有稳定目标身份的内容绑定，并解除独立引用；DSH 会话日志未删除。",
        12_000
      );
    }
    this.activePath = this.app.workspace.getActiveFile()?.path ?? null;

    this.registerView(DSH_MAIN_SESSION_VIEW_TYPE, (leaf) => new MainInstanceView(leaf, this));
    this.registerView(DSH_AGENT_WORKBENCH_VIEW_TYPE, (leaf) => new AgentWorkbenchView(leaf, this));
    this.addSettingTab(new DeepSeekHarnessSettingTab(this.app, this));

    if (this.settings.openMainSessionOnLoad) {
      const timer = window.setTimeout(() => void this.activateMainSession(), 800);
      this.register(() => window.clearTimeout(timer));
    }

    // Follow the active note only when the DSH view is already open. Merely
    // navigating the vault must not boot a hidden copy of the official GUI.
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file === null) return;
      this.activePath = file.path;
      if (this.app.workspace.getLeavesOfType(DSH_MAIN_SESSION_VIEW_TYPE).length === 0) return;
      void this.getGuiInstance()
        .then(async (gui) => {
          const sessionId = await this.ensureSessionForPath(file.path, gui, false);
          if (sessionId !== null) await gui.openSession(sessionId);
        })
        .catch((error: unknown) => this.showError("打开 DSH 会话失败", error));
    }));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      const sessionIds = this.settings.sessionsByPath[file.path] ?? [];
      const active = this.settings.sessionByPath[file.path];
      for (const [index, sessionId] of sessionIds.entries()) {
        menu.addItem((item) => item
          .setTitle(`会话 ${index + 1}｜${this.sessionDisplayTitle(sessionId, index)}`)
          .setIcon("message-circle")
          .setChecked(sessionId === active)
          .setSection("dsh-sessions")
          .onClick(() => void this.openSpecificSessionForPath(file.path, sessionId)));
      }
      if (sessionIds.length > 0) menu.addSeparator();
      menu.addItem((item) => item
        .setTitle(sessionIds.length === 0 ? "新建 DSH 会话" : "新建另一个 DSH 会话")
        .setIcon("message-circle-plus")
        .setSection("dsh-sessions")
        .onClick(() => void this.createSessionForPath(file.path)));
    }));

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      void this.reconcileStoredTargetsAfterLayout()
        .catch((error: unknown) => this.showError("恢复 DSH 目标绑定失败", error));
      this.fileTreeBridge = new FileTreeBridge(this);
      this.fileTreeBridge.attach();
      if (this.guiInstance !== null) {
        this.fileTreeBridge.bindSessionStateSource(this.guiInstance.sessionStates);
      }
      this.fileTreeBridge.revealFileExplorerTab(2_000, 5_000);
    });

    this.addRibbonIcon("bot", "打开 AI 工作台", () => void this.activateAgentWorkbench());
    this.addCommand({
      id: "open-dsh-agent-workbench",
      name: "打开 AI 工作台",
      callback: () => void this.activateAgentWorkbench()
    });
    this.addCommand({
      id: "open-dsh-main-session",
      name: "打开 DSH 右栏",
      callback: () => void this.activateMainSession()
    });

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.handleRename(file, oldPath);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      void this.handleDelete(file);
    }));
  }

  onunload(): void {
    this.unloaded = true;
    this.fileTreeBridge?.detach();
    this.fileTreeBridge = null;
    this.guiInstance?.dispose();
    this.guiInstance = null;
    this.guiPromise = null;
  }

  /** Lazy singleton shared by the one DSH view and file-tree bindings. */
  getGuiInstance(): Promise<GuiHandle> {
    if (this.guiInstance !== null) return Promise.resolve(this.guiInstance);
    if (this.guiPromise !== null) return this.guiPromise;
    this.guiPromise = this.bootGui().catch((error: unknown) => {
      this.guiPromise = null;
      throw error;
    });
    return this.guiPromise;
  }

  private async bootGui(): Promise<GuiHandle> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new MainInstanceError("plugin-dir", "无法定位插件目录（非 FileSystemAdapter）");
    }
    const dir = this.manifest.dir;
    if (dir === undefined) throw new MainInstanceError("plugin-dir", "manifest 缺少插件目录");
    const gui = await startGui(MAIN_INSTANCE_URL, join(adapter.getBasePath(), dir));
    if (this.unloaded) {
      gui.dispose();
      throw new MainInstanceError("unloaded", "插件已卸载，取消挂载 DSH 界面");
    }
    this.guiInstance = gui;
    this.fileTreeBridge?.bindSessionStateSource(gui.sessionStates);
    return gui;
  }

  async activateMainSession(syncActivePath = true): Promise<void> {
    // Capture before revealLeaf makes the DSH sidebar the active leaf (at that
    // point Workspace.getActiveFile() may legitimately return null).
    const contentPath = this.app.workspace.getActiveFile()?.path ?? this.activePath;
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(DSH_MAIN_SESSION_VIEW_TYPE)[0] ?? null;
    if (leaf === null) leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice("无法创建 DSH 右栏");
      return;
    }
    await leaf.setViewState({ type: DSH_MAIN_SESSION_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (syncActivePath && contentPath !== null) {
      try {
        const gui = await this.getGuiInstance();
        const sessionId = await this.ensureSessionForPath(contentPath, gui, false);
        if (sessionId !== null) await gui.openSession(sessionId);
      } catch (error) {
        this.showError("同步当前文件的 DSH 会话失败", error);
      }
    }
  }

  /** Reveal the native path-free Session manager in the left sidebar. */
  async activateAgentWorkbench(): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace
      .getLeavesOfType(DSH_AGENT_WORKBENCH_VIEW_TYPE)[0] ?? null;
    if (leaf === null) leaf = this.app.workspace.getLeftLeaf(false);
    if (leaf === null) {
      new Notice("无法创建 AI 工作台");
      return;
    }
    await leaf.setViewState({ type: DSH_AGENT_WORKBENCH_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Create one native workbench folder that can own multiple Sessions. */
  async createStandaloneSessionGroup(name: string): Promise<void> {
    try {
      this.settings.standaloneSessionGroups = addStandaloneSessionGroup(
        this.settings.standaloneSessionGroups,
        randomUUID(),
        name
      );
      await this.saveSettings();
      this.refreshAgentWorkbenchViews();
    } catch (error) {
      this.showError("新建会话文件夹失败", error);
      throw error;
    }
  }

  /** Create one official DSH Session inside an explicit workbench folder. */
  async createStandaloneSession(groupId: string): Promise<void> {
    if (this.standaloneCreatePromise !== null) return this.standaloneCreatePromise;
    const operation = this.createStandaloneSessionOnce(groupId);
    this.standaloneCreatePromise = operation;
    try {
      await operation;
    } catch (error) {
      this.showError("新建独立 DSH 会话失败", error);
    } finally {
      if (this.standaloneCreatePromise === operation) this.standaloneCreatePromise = null;
    }
  }

  private async createStandaloneSessionOnce(groupId: string): Promise<void> {
    const group = this.settings.standaloneSessionGroups.find((value) => value.groupId === groupId);
    if (group === undefined) throw new MainInstanceError("standalone-group", "会话文件夹不存在");
    const gui = await this.getGuiInstance();
    const workspaceId = await this.resolveStandaloneWorkspaceId();
    const created = await this.mainClient.createSession(undefined, workspaceId ?? undefined);
    const ordinal = group.sessionIds.length + 1;
    await this.mainClient.renameSession(
      created.sessionId,
      this.initialStandaloneSessionTitle(group.name, ordinal)
    );
    if (this.unloaded) throw new MainInstanceError("unloaded", "插件已卸载，未登记新建的独立会话");
    const next = addStandaloneSessionBinding(
      this.settings.standaloneSessionGroups,
      groupId,
      created.sessionId
    );
    this.settings.standaloneSessionGroups = next.groups;
    this.settings.activeStandaloneSessionId = next.activeSessionId;
    await this.saveSettings();
    this.refreshAgentWorkbenchViews();
    await gui.openSession(created.sessionId);
    await this.activateMainSession(false);
  }

  /** Select one explicit path-free member and open its official conversation. */
  async openStandaloneSession(sessionId: string): Promise<void> {
    try {
      const gui = await this.getGuiInstance();
      await this.reconcileStandaloneSessions();
      this.settings.activeStandaloneSessionId = selectStandaloneSessionBinding(
        this.settings.standaloneSessionGroups,
        this.settings.activeStandaloneSessionId,
        sessionId
      );
      await this.saveSettings();
      this.refreshAgentWorkbenchViews();
      await gui.openSession(sessionId);
      await this.activateMainSession(false);
    } catch (error) {
      this.showError("切换独立 DSH 会话失败", error);
    }
  }

  /** Remove only stale local references after an authoritative 3080 list succeeds. */
  async reconcileStandaloneSessions(): Promise<void> {
    const available = new Set(
      (await this.mainClient.listSessions())
        .filter((session) => session.origin !== "subagent")
        .map((session) => session.sessionId)
    );
    const contentSessionIds = new Set(Object.values(this.settings.sessionsByPath).flat());
    const normalized = normalizeStandaloneSessionBindings(
      this.settings.standaloneSessionGroups.map((group) => ({
        ...group,
        sessionIds: group.sessionIds.filter((sessionId) => available.has(sessionId))
      })),
      [],
      this.settings.activeStandaloneSessionId,
      contentSessionIds
    );
    if (
      sameStandaloneGroups(normalized.groups, this.settings.standaloneSessionGroups) &&
      normalized.activeSessionId === this.settings.activeStandaloneSessionId
    ) return;
    this.settings.standaloneSessionGroups = normalized.groups;
    this.settings.activeStandaloneSessionId = normalized.activeSessionId;
    await this.saveSettings();
    this.refreshAgentWorkbenchViews();
  }

  /** DSH workspaces available for the workbench's default Shell cwd. */
  listStandaloneWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.mainClient.listWorkspaces();
  }

  async getStandaloneWorkspace(): Promise<WorkspaceSummary | null> {
    const workspaceId = this.settings.standaloneWorkspaceId;
    if (workspaceId === null) return null;
    return (await this.mainClient.listWorkspaces())
      .find((workspace) => workspace.workspaceId === workspaceId) ?? null;
  }

  /** Open the official host directory picker and register the chosen path. */
  async pickStandaloneWorkspace(signal: AbortSignal): Promise<WorkspaceSummary | null> {
    const path = await this.mainClient.pickDirectory(signal);
    if (path === null) return null;
    const result = await this.mainClient.createWorkspace(path);
    await this.setStandaloneWorkspace(result.workspace.workspaceId);
    return result.workspace;
  }

  /** Make one DSH file workspace the default for Sessions created from now on. */
  async setStandaloneWorkspace(workspaceId: string | null): Promise<void> {
    if (workspaceId === null) {
      this.settings.standaloneWorkspaceId = null;
      await this.saveSettings();
      this.refreshAgentWorkbenchViews();
      return;
    }
    const workspace = (await this.mainClient.listWorkspaces())
      .find((value) => value.workspaceId === workspaceId);
    if (workspace === undefined) throw new MainInstanceError("workspace-missing", "所选工作文件夹已不存在");
    this.settings.standaloneWorkspaceId = workspaceId;
    await this.saveSettings();
    if (this.guiInstance !== null) await this.guiInstance.refreshWorkspaces();
    this.refreshAgentWorkbenchViews();
  }

  private async resolveStandaloneWorkspaceId(): Promise<string | null> {
    const workspaceId = this.settings.standaloneWorkspaceId;
    if (workspaceId === null) return null;
    const exists = (await this.mainClient.listWorkspaces())
      .some((workspace) => workspace.workspaceId === workspaceId);
    if (!exists) {
      throw new MainInstanceError("workspace-missing", "默认工作文件夹已失效，请在 AI 工作台重新选择");
    }
    return workspaceId;
  }

  /** Open the path-bound session, or create and persist one on 3080. */
  async openSessionForPath(path: string): Promise<void> {
    try {
      const gui = await this.getGuiInstance();
      const sessionId = await this.ensureSessionForPath(path, gui, true);
      if (sessionId === null) return;
      await gui.openSession(sessionId);
      await this.activateMainSession(false);
    } catch (error) {
      this.showError("打开 DSH 会话失败", error);
    }
  }

  /** Always create a fresh Session for this target; never reuse a workspace blank. */
  async createSessionForPath(path: string): Promise<void> {
    try {
      const gui = await this.getGuiInstance();
      const sessionId = await this.createSessionForPathInternal(path, gui);
      await gui.openSession(sessionId);
      await this.activateMainSession(false);
    } catch (error) {
      this.showError("新建 DSH 会话失败", error);
    }
  }

  /** Select and open one explicit member of a path's Session set. */
  async openSpecificSessionForPath(path: string, sessionId: string): Promise<void> {
    try {
      const gui = await this.getGuiInstance();
      const resolvedSessionId = await this.ensureSessionWorkspace(path, sessionId, gui);
      this.settings.sessionByPath = selectSessionBinding(
        this.settings.sessionsByPath,
        this.settings.sessionByPath,
        path,
        resolvedSessionId
      );
      await this.saveSettings();
      await this.bindTargetContext(path, resolvedSessionId, "active");
      await gui.openSession(resolvedSessionId);
      await this.activateMainSession(false);
    } catch (error) {
      this.showError("切换 DSH 会话失败", error);
    }
  }

  getSessionIdsForPath(path: string): readonly string[] {
    return this.settings.sessionsByPath[path] ?? [];
  }

  /** Resolve stale bindings and return the path's current Session. */
  private async ensureSessionForPath(path: string, gui: GuiHandle, create: boolean): Promise<string | null> {
    const configured = this.settings.sessionsByPath[path] ?? [];
    if (configured.length > 0) {
      const available = new Set(
        (await this.mainClient.listSessions())
          .filter((session) => session.origin !== "subagent")
          .map((session) => session.sessionId)
      );
      const valid = configured.filter((sessionId) => available.has(sessionId));
      if (valid.length !== configured.length) {
        if (valid.length === 0) {
          this.settings.sessionsByPath = removePathBindings(this.settings.sessionsByPath, path);
          this.settings.sessionByPath = removePathBindings(this.settings.sessionByPath, path);
          this.settings.targetIdByPath = removePathBindings(this.settings.targetIdByPath, path);
          this.settings.targetKindByPath = removePathBindings(this.settings.targetKindByPath, path);
        } else {
          this.settings.sessionsByPath = { ...this.settings.sessionsByPath, [path]: valid };
          const active = this.settings.sessionByPath[path];
          this.settings.sessionByPath = {
            ...this.settings.sessionByPath,
            [path]: active !== undefined && valid.includes(active) ? active : valid[0]!
          };
        }
        await this.saveSettings();
      }
      const active = this.settings.sessionByPath[path];
      if (active !== undefined && valid.includes(active)) {
        const resolvedSessionId = await this.ensureSessionWorkspace(path, active, gui);
        await this.bindTargetContext(path, resolvedSessionId, "active");
        return resolvedSessionId;
      }
    }
    if (!create) return null;
    return this.createSessionForPathInternal(path, gui);
  }

  private async createSessionForPathInternal(path: string, gui: GuiHandle): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) && !(file instanceof TFolder)) {
      throw new MainInstanceError("target-missing", `Obsidian 目标不存在：${path}`);
    }
    const kind = file instanceof TFolder ? "folder" : "file";
    const targetId = this.settings.targetIdByPath[path] ?? randomUUID();
    const workspace = await this.ensureWorkspaceForPath(path, kind);
    const result = await this.mainClient.createSession(undefined, workspace.workspaceId);
    const ordinal = (this.settings.sessionsByPath[path]?.length ?? 0) + 1;
    await this.mainClient.renameSession(result.sessionId, this.initialSessionTitle(path, kind, ordinal));
    await this.mainClient.bindObsidianTarget({
      protocolVersion: 1,
      sessionId: result.sessionId,
      vaultId: this.settings.vaultId,
      targetId,
      kind,
      path,
      state: "active"
    });
    const next = addSessionBinding(
      this.settings.sessionsByPath,
      this.settings.sessionByPath,
      path,
      result.sessionId
    );
    this.settings.sessionsByPath = next.sessionsByPath;
    this.settings.sessionByPath = next.sessionByPath;
    this.settings.targetIdByPath = { ...this.settings.targetIdByPath, [path]: targetId };
    this.settings.targetKindByPath = { ...this.settings.targetKindByPath, [path]: kind };
    await this.saveSettings();
    await gui.refreshWorkspaces();
    return result.sessionId;
  }

  private async bindTargetContext(
    path: string,
    sessionId: string,
    state: "active" | "deleted",
    targetId = this.settings.targetIdByPath[path],
    kind = this.settings.targetKindByPath[path]
  ): Promise<void> {
    if (targetId === undefined || kind === undefined) {
      throw new MainInstanceError("target-identity", `目标身份不完整：${path}`);
    }
    await this.mainClient.bindObsidianTarget({
      protocolVersion: 1,
      sessionId,
      vaultId: this.settings.vaultId,
      targetId,
      kind,
      path,
      state
    });
  }

  private initialSessionTitle(path: string, kind: "file" | "folder", ordinal: number): string {
    const prefix = kind === "file" ? "文件" : "目录";
    const title = `${prefix} · ${path} · ${ordinal}`;
    return title.length <= 180 ? title : `${prefix} · …${path.slice(-160)} · ${ordinal}`;
  }

  private initialStandaloneSessionTitle(groupName: string, ordinal: number): string {
    const title = `AI 工作台 · ${groupName} · 会话 ${ordinal}`;
    return title.length <= 180 ? title : `AI 工作台 · …${groupName.slice(-140)} · 会话 ${ordinal}`;
  }

  private refreshAgentWorkbenchViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DSH_AGENT_WORKBENCH_VIEW_TYPE)) {
      if (leaf.view instanceof AgentWorkbenchView) leaf.view.refresh();
    }
  }

  private sessionDisplayTitle(sessionId: string, index: number): string {
    const state = this.guiInstance?.sessionStates.getSnapshot()
      .find((session) => session.sessionId === sessionId);
    return state?.displayTitle ?? `DSH 会话 ${index + 1}`;
  }

  private async ensureWorkspaceForPath(
    path: string,
    kind = this.settings.targetKindByPath[path]
  ): Promise<WorkspaceSummary> {
    if (kind === undefined) throw new MainInstanceError("target-kind", `目标类型未知：${path}`);
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new MainInstanceError("workspace-path", "无法为非本地 Vault 创建文件工作区");
    }
    const expectedPath = targetWorkspacePath(adapter.getBasePath(), path, kind);
    const existing = (await this.mainClient.listWorkspaces())
      .find((workspace) => resolve(workspace.path) === expectedPath);
    if (existing !== undefined) return existing;
    return (await this.mainClient.createWorkspace(expectedPath)).workspace;
  }

  private async ensureSessionWorkspace(path: string, sessionId: string, gui: GuiHandle): Promise<string> {
    const workspace = await this.ensureWorkspaceForPath(path);
    if (workspace.sessionIds.includes(sessionId)) return sessionId;
    try {
      await this.mainClient.moveSessionToWorkspace(workspace.workspaceId, sessionId);
      await gui.refreshWorkspaces();
      return sessionId;
    } catch (error) {
      if (!(error instanceof MainInstanceError) || error.code !== "workspace-move-invalid") throw error;
    }

    const legacy = (await this.mainClient.listSessions())
      .find((session) => session.sessionId === sessionId);
    if (legacy === undefined || !legacy.blank || legacy.running) {
      throw new MainInstanceError(
        "workspace-migration-required",
        `会话 ${sessionId} 不属于文件工作区且已有内容，已保留原会话，请显式新建工作区会话`
      );
    }
    const replacement = await this.replaceBlankSessionForWorkspace(path, legacy, workspace);
    await gui.refreshWorkspaces();
    return replacement;
  }

  private async replaceBlankSessionForWorkspace(
    path: string,
    legacy: SessionSummary,
    workspace: WorkspaceSummary
  ): Promise<string> {
    const kind = this.settings.targetKindByPath[path];
    const targetId = this.settings.targetIdByPath[path];
    if (kind === undefined || targetId === undefined) {
      throw new MainInstanceError("target-identity", `目标身份不完整：${path}`);
    }
    const memberIndex = (this.settings.sessionsByPath[path] ?? []).indexOf(legacy.sessionId);
    if (memberIndex < 0) {
      throw new MainInstanceError("session-binding", `会话未绑定到目标：${legacy.sessionId}`);
    }
    const created = await this.mainClient.createSession(undefined, workspace.workspaceId);
    const title = legacy.projections?.values?.title;
    await this.mainClient.renameSession(
      created.sessionId,
      typeof title === "string" ? title : this.initialSessionTitle(path, kind, memberIndex + 1)
    );
    if (legacy.agentPreset !== undefined) {
      await this.mainClient.selectAgentPreset(created.sessionId, legacy.agentPreset);
    }
    await this.mainClient.bindObsidianTarget({
      protocolVersion: 1,
      sessionId: legacy.sessionId,
      vaultId: this.settings.vaultId,
      targetId,
      kind,
      path,
      state: "deleted"
    });
    await this.mainClient.bindObsidianTarget({
      protocolVersion: 1,
      sessionId: created.sessionId,
      vaultId: this.settings.vaultId,
      targetId,
      kind,
      path,
      state: "active"
    });
    const next = replaceSessionBinding(
      this.settings.sessionsByPath,
      this.settings.sessionByPath,
      path,
      legacy.sessionId,
      created.sessionId
    );
    this.settings.sessionsByPath = next.sessionsByPath;
    this.settings.sessionByPath = next.sessionByPath;
    await this.saveSettings();
    return created.sessionId;
  }

  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.activePath === oldPath || this.activePath?.startsWith(`${oldPath}/`) === true) {
      this.activePath = `${file.path}${this.activePath.slice(oldPath.length)}`;
    }
    const affected = Object.entries(this.settings.sessionsByPath)
      .filter(([path]) => isPathOrChild(path, oldPath))
      .map(([path, sessionIds]) => ({
        path,
        sessionIds,
        kind: this.settings.targetKindByPath[path]
      }));
    if (affected.length === 0) return;
    this.settings.sessionsByPath = movePathBindings(this.settings.sessionsByPath, oldPath, file.path);
    this.settings.sessionByPath = movePathBindings(this.settings.sessionByPath, oldPath, file.path);
    this.settings.targetIdByPath = movePathBindings(this.settings.targetIdByPath, oldPath, file.path);
    this.settings.targetKindByPath = movePathBindings(this.settings.targetKindByPath, oldPath, file.path);
    await this.saveSettings();
    const officialTitles = await this.officialSessionTitles();
    const tasks: Array<Promise<void>> = [];
    for (const target of affected) {
      const nextPath = `${file.path}${target.path.slice(oldPath.length)}`;
      for (const [index, sessionId] of target.sessionIds.entries()) {
        tasks.push(this.bindTargetContext(nextPath, sessionId, "active"));
        if (target.kind === undefined) continue;
        const generatedTitle = this.initialSessionTitle(target.path, target.kind, index + 1);
        if (officialTitles.get(sessionId) !== generatedTitle) continue;
        tasks.push(this.mainClient.renameSession(
          sessionId,
          this.initialSessionTitle(nextPath, target.kind, index + 1)
        ));
      }
    }
    const results = await Promise.allSettled(tasks);
    this.reportTargetSyncFailures("文件改名后的 DSH 目标或标题同步失败", results);
  }

  /** Read official titles once; generated labels follow rename, user titles do not. */
  private async officialSessionTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    for (const session of this.guiInstance?.sessionStates.getSnapshot() ?? []) {
      if (session.displayTitle !== undefined) titles.set(session.sessionId, session.displayTitle);
    }
    try {
      for (const session of await this.mainClient.listSessions()) {
        const title = session.projections?.values?.title;
        if (!titles.has(session.sessionId) && typeof title === "string") {
          titles.set(session.sessionId, title);
        }
      }
    } catch {
      // Target identity still follows the Vault rename; unknown titles are
      // left untouched so a user-authored DSH title is never overwritten.
    }
    return titles;
  }

  private async handleDelete(file: TAbstractFile): Promise<void> {
    if (this.activePath === file.path || this.activePath?.startsWith(`${file.path}/`) === true) {
      this.activePath = null;
    }
    const affected = Object.entries(this.settings.sessionsByPath)
      .filter(([path]) => isPathOrChild(path, file.path))
      .map(([path, sessionIds]) => ({
        path,
        sessionIds,
        targetId: this.settings.targetIdByPath[path],
        kind: this.settings.targetKindByPath[path]
      }));
    if (affected.length === 0) return;
    this.settings.sessionsByPath = removePathBindings(this.settings.sessionsByPath, file.path);
    this.settings.sessionByPath = removePathBindings(this.settings.sessionByPath, file.path);
    this.settings.targetIdByPath = removePathBindings(this.settings.targetIdByPath, file.path);
    this.settings.targetKindByPath = removePathBindings(this.settings.targetKindByPath, file.path);
    await this.saveSettings();
    const results = await Promise.allSettled(affected.flatMap((target) => {
      if (target.targetId === undefined || target.kind === undefined) return [];
      return target.sessionIds.map((sessionId) => this.bindTargetContext(
        target.path,
        sessionId,
        "deleted",
        target.targetId,
        target.kind
      ));
    }));
    this.reportTargetSyncFailures("文件删除后的 DSH 目标同步失败", results);
  }

  /**
   * Plugin onload can run before Obsidian has restored the Vault index. Keep
   * persisted path bindings intact there, then reconcile against the
   * authoritative Vault only after layout ready.
   */
  private async reconcileStoredTargetsAfterLayout(): Promise<void> {
    const stale: Array<{
      path: string;
      sessionIds: string[];
      targetId: string | undefined;
      kind: "file" | "folder" | undefined;
    }> = [];
    const sessionsByPath = { ...this.settings.sessionsByPath };
    const sessionByPath = { ...this.settings.sessionByPath };
    const targetIdByPath = { ...this.settings.targetIdByPath };
    const targetKindByPath = { ...this.settings.targetKindByPath };
    let changed = false;
    for (const [path, sessionIds] of Object.entries(sessionsByPath)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) && !(file instanceof TFolder)) {
        stale.push({
          path,
          sessionIds,
          targetId: targetIdByPath[path],
          kind: targetKindByPath[path]
        });
        delete sessionsByPath[path];
        delete sessionByPath[path];
        delete targetIdByPath[path];
        delete targetKindByPath[path];
        changed = true;
        continue;
      }
      const kind = file instanceof TFolder ? "folder" : "file";
      if (targetKindByPath[path] !== kind) {
        targetKindByPath[path] = kind;
        changed = true;
      }
    }
    if (!changed) return;
    this.settings.sessionsByPath = sessionsByPath;
    this.settings.sessionByPath = sessionByPath;
    this.settings.targetIdByPath = targetIdByPath;
    this.settings.targetKindByPath = targetKindByPath;
    await this.saveSettings();
    const results = await Promise.allSettled(stale.flatMap((target) => {
      if (target.targetId === undefined || target.kind === undefined) return [];
      return target.sessionIds.map((sessionId) => this.bindTargetContext(
        target.path,
        sessionId,
        "deleted",
        target.targetId,
        target.kind
      ));
    }));
    this.reportTargetSyncFailures("恢复时清理已删除目标失败", results);
  }

  async saveSettings(): Promise<void> {
    await this.settingsWriter.save(this.settings);
  }

  private async loadSettings(): Promise<void> {
    const stored = asRecord(await this.loadData());
    const rawActive = stringMap(stored.sessionByPath);
    const rawMemberships = stringArrayMap(stored.sessionsByPath);
    const safeMemberships = Object.fromEntries(
      Object.entries(rawMemberships).filter(([path]) => isSafeVaultPath(path))
    );
    const safeActive = Object.fromEntries(
      Object.entries(rawActive).filter(([path]) => isSafeVaultPath(path))
    );
    const normalized = normalizeSessionBindings(safeMemberships, safeActive);
    this.migratedConflictPaths = normalized.conflictingPathCount;
    this.migratedConflictSessions = normalized.conflictingSessionIds.length;
    const contentSessionIds = new Set(Object.values(normalized.sessionsByPath).flat());
    const standalone = normalizeStandaloneSessionBindings(
      safeStandaloneSessionGroups(stored.standaloneSessionGroups),
      safeSessionIdArray(stored.standaloneSessionIds),
      typeof stored.activeStandaloneSessionId === "string" && isSafeId(stored.activeStandaloneSessionId)
        ? stored.activeStandaloneSessionId
        : null,
      contentSessionIds
    );
    this.migratedStandaloneConflicts = standalone.conflictingSessionIds.length;
    const rawTargetIds = stringMap(stored.targetIdByPath);
    const rawTargetKinds = targetKindMap(stored.targetKindByPath);
    const targetIdByPath: Record<string, string> = {};
    const targetKindByPath: Record<string, "file" | "folder"> = {};
    for (const path of Object.keys(normalized.sessionsByPath)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const storedTargetId = rawTargetIds[path];
      targetIdByPath[path] = storedTargetId !== undefined && isSafeId(storedTargetId)
        ? storedTargetId
        : randomUUID();
      if (file instanceof TFile || file instanceof TFolder) {
        targetKindByPath[path] = file instanceof TFolder ? "folder" : "file";
      } else if (rawTargetKinds[path] !== undefined) {
        targetKindByPath[path] = rawTargetKinds[path];
      }
    }
    this.settings = {
      vaultId: typeof stored.vaultId === "string" && isSafeId(stored.vaultId) ? stored.vaultId : randomUUID(),
      sessionsByPath: normalized.sessionsByPath,
      sessionByPath: normalized.sessionByPath,
      targetIdByPath,
      targetKindByPath,
      standaloneSessionGroups: standalone.groups,
      activeStandaloneSessionId: standalone.activeSessionId,
      standaloneWorkspaceId: typeof stored.standaloneWorkspaceId === "string" && isSafeId(stored.standaloneWorkspaceId)
        ? stored.standaloneWorkspaceId
        : null,
      openMainSessionOnLoad: typeof stored.openMainSessionOnLoad === "boolean"
        ? stored.openMainSessionOnLoad
        : DEFAULT_SETTINGS.openMainSessionOnLoad
    };

    // Persist the compact schema once so retired runtime configuration is
    // removed from plugin state through the serialized writer.
    const storedKeys = Object.keys(stored);
    const hasLegacyKeys = storedKeys.some((key) => !ACTIVE_SETTING_KEYS.has(key));
    if (hasLegacyKeys || JSON.stringify(stored) !== JSON.stringify(this.settings)) {
      await this.saveSettings();
    }
  }

  private reportTargetSyncFailures(prefix: string, results: PromiseSettledResult<void>[]): void {
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length === 0) return;
    this.showError(prefix, failed[0]!.reason);
  }

  private showError(prefix: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    new Notice(`${prefix}：${detail}`, 8_000);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter(([path, item]) => path !== "" && typeof item === "string" && item !== "")
  ) as Record<string, string>;
}

function stringArrayMap(value: unknown): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([path, item]) => {
      if (path === "" || !Array.isArray(item)) return [];
      const ids = item.filter((entry): entry is string => typeof entry === "string" && entry !== "");
      return ids.length === 0 ? [] : [[path, ids]];
    })
  );
}

function safeSessionIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && isSafeId(entry));
}

function safeStandaloneSessionGroups(value: unknown): StandaloneSessionGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): StandaloneSessionGroup[] => {
    const record = asRecord(entry);
    if (
      typeof record.groupId !== "string" || !isSafeId(record.groupId) ||
      typeof record.name !== "string" || record.name.trim() === "" || record.name.trim().length > 80
    ) return [];
    return [{
      groupId: record.groupId,
      name: record.name.trim(),
      sessionIds: safeSessionIdArray(record.sessionIds)
    }];
  });
}

function targetKindMap(value: unknown): Record<string, "file" | "folder"> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, "file" | "folder"] =>
      entry[1] === "file" || entry[1] === "folder"
    )
  );
}

function isSafeId(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isSafeVaultPath(path: string): boolean {
  if (path === "" || path.length > 1_024 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPathOrChild(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStandaloneGroups(
  left: readonly StandaloneSessionGroup[],
  right: readonly StandaloneSessionGroup[]
): boolean {
  return left.length === right.length && left.every((group, index) => {
    const other = right[index];
    return other !== undefined && group.groupId === other.groupId && group.name === other.name &&
      sameStringArray(group.sessionIds, other.sessionIds);
  });
}
