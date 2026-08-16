import {
  App,
  ItemView,
  Modal,
  Notice,
  Setting,
  TextComponent,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import type DeepSeekHarnessPlugin from "../main";
import type { StandaloneSessionGroup } from "../state/standalone-session-map";
import type { GuiSessionState, GuiSessionStateSource } from "./gui/gui-boot";
import type { WorkspaceSummary } from "./main-instance-client";

export const DSH_AGENT_WORKBENCH_VIEW_TYPE = "dsh-agent-workbench";

/**
 * Native left-sidebar projection for path-free Agent Sessions. Conversation
 * rendering remains in the official DSH right panel; this view only owns the
 * explicit folder membership, default cwd and Session selection affordances.
 */
export class AgentWorkbenchView extends ItemView {
  private generation = 0;
  private workspaceGeneration = 0;
  private stopSessionStates: (() => void) | null = null;
  private sessionStates = new Map<string, GuiSessionState>();
  private collapsedGroups = new Set<string>();
  private connectionState: "loading" | "ready" | "error" = "loading";
  private workspaceState: "loading" | "ready" | "error" = "loading";
  private selectedWorkspace: WorkspaceSummary | null = null;
  private rootEl: HTMLElement | null = null;
  private creatingGroupId: string | null = null;
  private workspacePickerAbort: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: DeepSeekHarnessPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return DSH_AGENT_WORKBENCH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI 工作台";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const generation = ++this.generation;
    this.rootEl = this.contentEl;
    this.rootEl.addClass("dsh-agent-workbench");
    this.bindActions();
    this.render();
    void this.refreshWorkspace();
    try {
      const gui = await this.plugin.getGuiInstance();
      if (generation !== this.generation) return;
      this.bindSessionStates(gui.sessionStates, generation);
      await this.plugin.reconcileStandaloneSessions();
      if (generation !== this.generation) return;
      this.connectionState = "ready";
      this.applySessionStates(gui.sessionStates.getSnapshot());
    } catch {
      if (generation !== this.generation) return;
      this.connectionState = "error";
      this.render();
    }
  }

  onClose(): Promise<void> {
    this.generation += 1;
    this.workspaceGeneration += 1;
    this.workspacePickerAbort?.abort();
    this.workspacePickerAbort = null;
    this.stopSessionStates?.();
    this.stopSessionStates = null;
    this.sessionStates.clear();
    this.rootEl = null;
    return Promise.resolve();
  }

  /** Re-project plugin-owned membership after a serialized settings change. */
  refresh(): void {
    this.render();
    void this.refreshWorkspace();
  }

  private bindActions(): void {
    if (this.rootEl === null) return;
    this.registerDomEvent(this.rootEl, "click", (event) => {
      const target = event.target;
      const button = target instanceof Element ? target.closest("button[data-action]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const action = button.dataset.action;
      const groupId = button.dataset.groupId;
      const sessionId = button.dataset.sessionId;
      if (action === "new-group") this.openGroupModal();
      else if (action === "choose-workspace") void this.openWorkspacePicker();
      else if (action === "toggle-group" && groupId !== undefined) this.toggleGroup(groupId);
      else if (action === "new-session" && groupId !== undefined) void this.createSession(groupId);
      else if (action === "open-session" && sessionId !== undefined) {
        void this.plugin.openStandaloneSession(sessionId);
      }
    });
  }

  private bindSessionStates(source: GuiSessionStateSource, generation: number): void {
    this.stopSessionStates?.();
    const apply = (): void => {
      if (generation !== this.generation) return;
      this.applySessionStates(source.getSnapshot());
    };
    this.stopSessionStates = source.subscribe(apply);
    apply();
  }

  private applySessionStates(values: readonly GuiSessionState[]): void {
    this.sessionStates = new Map(values.map((session) => [session.sessionId, session]));
    this.render();
  }

  private render(): void {
    if (this.rootEl === null) return;
    this.rootEl.empty();
    this.renderToolbar(this.rootEl);
    this.renderWorkspace(this.rootEl);
    if (this.connectionState === "error") {
      this.rootEl.createDiv({
        cls: "dsh-agent-workbench__notice is-error",
        text: "DSH 暂不可用；会话分组已保留。"
      });
    }
    const tree = this.rootEl.createDiv({
      cls: "dsh-agent-workbench__tree",
      attr: { role: "tree", "aria-label": "AI 工作台会话文件夹" }
    });
    for (const group of this.plugin.settings.standaloneSessionGroups) {
      this.renderGroup(tree, group);
    }
  }

  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "dsh-agent-workbench__toolbar" });
    toolbar.createDiv({ cls: "dsh-agent-workbench__title", text: "AI 工作台" });
    const actions = toolbar.createDiv({ cls: "dsh-agent-workbench__toolbar-actions" });
    const workspaceButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: {
        type: "button",
        "data-action": "choose-workspace",
        "aria-label": "设置默认工作文件夹",
        title: "设置默认工作文件夹"
      }
    });
    setIcon(workspaceButton, "folder-cog");
    const groupButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: {
        type: "button",
        "data-action": "new-group",
        "aria-label": "新建会话文件夹",
        title: "新建会话文件夹"
      }
    });
    setIcon(groupButton, "folder-plus");
  }

  private renderWorkspace(root: HTMLElement): void {
    const button = root.createEl("button", {
      cls: "dsh-agent-workbench__workspace",
      attr: {
        type: "button",
        "data-action": "choose-workspace",
        "aria-label": "选择 AI 工作台默认工作文件夹"
      }
    });
    const icon = button.createSpan({ cls: "dsh-agent-workbench__workspace-icon" });
    setIcon(icon, "folder-root");
    const body = button.createSpan({ cls: "dsh-agent-workbench__workspace-body" });
    body.createSpan({ cls: "dsh-agent-workbench__workspace-label", text: "默认工作文件夹" });
    const configured = this.plugin.settings.standaloneWorkspaceId !== null;
    const workspaceText = this.workspaceState === "loading"
      ? "正在读取…"
      : this.workspaceState === "error"
        ? "无法读取，点击重试"
        : this.selectedWorkspace !== null
          ? workspaceName(this.selectedWorkspace)
          : configured
            ? "原文件夹已失效"
            : "未设置，点击选择";
    body.createSpan({ cls: "dsh-agent-workbench__workspace-value", text: workspaceText });
    if (this.selectedWorkspace !== null) button.title = this.selectedWorkspace.path;
    const chevron = button.createSpan({ cls: "dsh-agent-workbench__workspace-chevron" });
    setIcon(chevron, "chevron-right");
  }

  private renderGroup(tree: HTMLElement, group: StandaloneSessionGroup): void {
    const collapsed = this.collapsedGroups.has(group.groupId);
    const groupEl = tree.createDiv({
      cls: "dsh-agent-workbench__group",
      attr: { role: "treeitem", "aria-expanded": String(!collapsed) }
    });
    const row = groupEl.createDiv({ cls: "dsh-agent-workbench__tree-row is-group" });
    const toggle = row.createEl("button", {
      cls: "dsh-agent-workbench__group-toggle",
      attr: {
        type: "button",
        "data-action": "toggle-group",
        "data-group-id": group.groupId,
        "aria-label": collapsed ? `展开 ${group.name}` : `折叠 ${group.name}`
      }
    });
    setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
    const folderIcon = row.createSpan({ cls: "dsh-agent-workbench__row-icon" });
    setIcon(folderIcon, collapsed ? "folder" : "folder-open");
    const nameButton = row.createEl("button", {
      cls: "dsh-agent-workbench__group-name",
      text: group.name,
      attr: {
        type: "button",
        "data-action": "toggle-group",
        "data-group-id": group.groupId
      }
    });
    nameButton.title = `${group.name} · ${group.sessionIds.length} 个 Session`;
    row.createSpan({ cls: "dsh-agent-workbench__group-count", text: String(group.sessionIds.length) });
    const add = row.createEl("button", {
      cls: "clickable-icon dsh-agent-workbench__group-add",
      attr: {
        type: "button",
        "data-action": "new-session",
        "data-group-id": group.groupId,
        "aria-label": `在 ${group.name} 中新建 Session`,
        title: `在 ${group.name} 中新建 Session`
      }
    });
    add.disabled = this.creatingGroupId !== null;
    setIcon(add, this.creatingGroupId === group.groupId ? "loader-circle" : "plus");

    if (collapsed) return;
    const children = groupEl.createDiv({ cls: "dsh-agent-workbench__children", attr: { role: "group" } });
    if (group.sessionIds.length === 0) {
      children.createDiv({ cls: "dsh-agent-workbench__empty-row", text: "用右侧 ＋ 新建 Session" });
      return;
    }
    const order = new Map(group.sessionIds.map((sessionId, index) => [sessionId, index]));
    const sorted = [...group.sessionIds].sort((left, right) => {
      const leftUpdated = this.sessionStates.get(left)?.updatedAt ?? order.get(left) ?? 0;
      const rightUpdated = this.sessionStates.get(right)?.updatedAt ?? order.get(right) ?? 0;
      return rightUpdated - leftUpdated;
    });
    for (const [index, sessionId] of sorted.entries()) {
      this.renderSession(children, sessionId, index);
    }
  }

  private renderSession(container: HTMLElement, sessionId: string, index: number): void {
    const state = this.sessionStates.get(sessionId);
    const active = this.plugin.settings.activeStandaloneSessionId === sessionId;
    const button = container.createEl("button", {
      cls: "dsh-agent-workbench__tree-row is-session",
      attr: {
        type: "button",
        role: "treeitem",
        "data-action": "open-session",
        "data-session-id": sessionId,
        title: `打开 Session：${state?.displayTitle ?? sessionId}`
      }
    });
    button.toggleClass("is-active", active);
    button.toggleClass("is-running", state?.running === true);
    if (active) button.setAttribute("aria-current", "true");
    button.createSpan({ cls: "dsh-agent-workbench__tree-spacer" });
    const icon = button.createSpan({ cls: "dsh-agent-workbench__row-icon" });
    setIcon(icon, "message-circle");
    button.createSpan({
      cls: "dsh-agent-workbench__session-title",
      text: state?.displayTitle ?? `会话 ${index + 1}`
    });
    const stateEl = button.createSpan({
      cls: "dsh-agent-workbench__session-state",
      text: state?.running === true ? "运行中" : state?.blank === true ? "未对话" : ""
    });
    stateEl.setAttribute("aria-label", state?.running === true ? "运行中" : state?.blank === true ? "尚未对话" : "空闲");
  }

  private toggleGroup(groupId: string): void {
    if (this.collapsedGroups.has(groupId)) this.collapsedGroups.delete(groupId);
    else this.collapsedGroups.add(groupId);
    this.render();
  }

  private openGroupModal(): void {
    new SessionGroupModal(this.app, async (name) => {
      await this.plugin.createStandaloneSessionGroup(name);
    }).open();
  }

  private async createSession(groupId: string): Promise<void> {
    if (this.creatingGroupId !== null) return;
    this.creatingGroupId = groupId;
    this.render();
    try {
      await this.plugin.createStandaloneSession(groupId);
    } finally {
      this.creatingGroupId = null;
      this.render();
    }
  }

  private async refreshWorkspace(): Promise<void> {
    const generation = ++this.workspaceGeneration;
    this.workspaceState = "loading";
    this.render();
    try {
      const workspace = await this.plugin.getStandaloneWorkspace();
      if (generation !== this.workspaceGeneration) return;
      this.selectedWorkspace = workspace;
      this.workspaceState = "ready";
    } catch {
      if (generation !== this.workspaceGeneration) return;
      this.selectedWorkspace = null;
      this.workspaceState = "error";
    }
    this.render();
  }

  private async openWorkspacePicker(): Promise<void> {
    try {
      const workspaces = await this.plugin.listStandaloneWorkspaces();
      new StandaloneWorkspaceModal(
        this.app,
        workspaces,
        this.plugin.settings.standaloneWorkspaceId,
        async (workspaceId) => {
          await this.plugin.setStandaloneWorkspace(workspaceId);
          await this.refreshWorkspace();
        },
        async () => {
          this.workspacePickerAbort?.abort();
          const controller = new AbortController();
          this.workspacePickerAbort = controller;
          try {
            const workspace = await this.plugin.pickStandaloneWorkspace(controller.signal);
            if (workspace !== null) await this.refreshWorkspace();
            return workspace !== null;
          } finally {
            if (this.workspacePickerAbort === controller) this.workspacePickerAbort = null;
          }
        }
      ).open();
    } catch (error) {
      new Notice(`读取 DSH 工作文件夹失败：${errorMessage(error)}`, 8_000);
    }
  }
}

class SessionGroupModal extends Modal {
  private input: TextComponent | null = null;
  private submitting = false;

  constructor(
    app: App,
    private readonly submit: (name: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("新建会话文件夹");
    const form = this.contentEl.createEl("form", { cls: "dsh-agent-workbench-modal" });
    new Setting(form)
      .setName("文件夹名称")
      .setDesc("用于整理多个独立 Agent Session。")
      .addText((input) => {
        this.input = input;
        input.setPlaceholder("例如：研究助手");
      });
    const footer = form.createDiv({ cls: "modal-button-container" });
    const cancel = footer.createEl("button", { text: "取消", attr: { type: "button" } });
    const create = footer.createEl("button", {
      cls: "mod-cta",
      text: "创建",
      attr: { type: "submit" }
    });
    cancel.addEventListener("click", () => this.close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.submitting) return;
      const name = this.input?.getValue().trim() ?? "";
      if (name === "" || name.length > 80) {
        new Notice("会话文件夹名称需要 1–80 个字符");
        return;
      }
      this.submitting = true;
      create.disabled = true;
      void this.submit(name)
        .then(() => this.close())
        .catch(() => {
          this.submitting = false;
          create.disabled = false;
        });
    });
    window.setTimeout(() => this.input?.inputEl.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class StandaloneWorkspaceModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly workspaces: readonly WorkspaceSummary[],
    private readonly selectedId: string | null,
    private readonly select: (workspaceId: string | null) => Promise<void>,
    private readonly pickDirectory: () => Promise<boolean>
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("默认工作文件夹");
    this.contentEl.createDiv({
      cls: "setting-item-description dsh-agent-workbench-modal__intro",
      text: "新建的独立 Session 将在此 DSH Workspace 中运行；这不会把会话绑定到某篇 Obsidian 笔记。"
    });
    const list = this.contentEl.createDiv({ cls: "dsh-agent-workbench-modal__workspace-list" });
    this.addWorkspaceSetting(list, null, "不设置默认文件夹", "新会话仍可创建，但需要在右栏手动选择工作区。");
    for (const workspace of this.workspaces) {
      this.addWorkspaceSetting(list, workspace.workspaceId, workspaceName(workspace), workspace.path);
    }
    new Setting(this.contentEl)
      .setName("选择其他文件夹")
      .setDesc("调用 DSH 官方目录选择器，并注册为一个文件 Workspace。")
      .addButton((button) => button
        .setIcon("folder-search")
        .setButtonText("浏览…")
        .onClick(async () => {
          if (this.busy) return;
          this.busy = true;
          button.setDisabled(true);
          try {
            if (await this.pickDirectory()) this.close();
          } catch (error) {
            if (errorMessage(error) !== "已取消目录选择") {
              new Notice(`选择工作文件夹失败：${errorMessage(error)}`, 8_000);
            }
          } finally {
            this.busy = false;
            button.setDisabled(false);
          }
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addWorkspaceSetting(
    container: HTMLElement,
    workspaceId: string | null,
    name: string,
    description: string
  ): void {
    const setting = new Setting(container).setName(name).setDesc(description);
    setting.addButton((button) => {
      const selected = workspaceId === this.selectedId;
      button.setIcon(selected ? "check" : "arrow-right");
      button.setTooltip(selected ? "当前默认工作文件夹" : "设为默认工作文件夹");
      button.setDisabled(selected);
      button.onClick(async () => {
        if (this.busy) return;
        this.busy = true;
        button.setDisabled(true);
        try {
          await this.select(workspaceId);
          this.close();
        } catch (error) {
          new Notice(`设置默认工作文件夹失败：${errorMessage(error)}`, 8_000);
          this.busy = false;
          button.setDisabled(false);
        }
      });
    });
  }
}

function workspaceName(workspace: WorkspaceSummary): string {
  const title = workspace.title?.trim();
  if (title !== undefined && title !== "") return title;
  const parts = workspace.path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? workspace.path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
