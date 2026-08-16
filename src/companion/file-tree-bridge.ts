/**
 * FileTreeBridge — fuses DSH session state into the NATIVE Obsidian file
 * explorer. Obsidian exposes no API for the file tree, so this bridge
 * observes the explorer DOM and paints a per-row session badge:
 *
 *   1…n file/folder has that many DSH Sessions (click → open the current one)
 *   ＋   no session yet                          (click → create + bind one)
 *
 * Sessions are managed per Obsidian path (settings.sessionsByPath), NOT via
 * the DSH global session list — the user's sessions follow their notes.
 */

import { Menu, TFolder } from "obsidian";
import type DeepSeekHarnessPlugin from "../main";
import type { GuiSessionState, GuiSessionStateSource } from "./gui/gui-boot";
import { MainInstanceClient, type HistoryPage } from "./main-instance-client";

const BADGE_CLASS = "dsh-session-badge";
const ROW_SELECTORS = [".tree-item-self", ".nav-file-title", ".nav-folder-title"];

export class FileTreeBridge {
  private observer: MutationObserver | null = null;
  private observeTarget: HTMLElement = document.body;
  private narrowed = false;
  private attached = false;
  private paintTimer: number | null = null;
  private readonly timers = new Set<number>();
  private painting = false;
  private sessionStateSource: GuiSessionStateSource | null = null;
  private stopSessionStateSource: (() => void) | null = null;
  private sessionStateGeneration = 0;
  private sessionStates = new Map<string, GuiSessionState>();

  private setTimer(callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  /** Once the tree is rendered, watch only the tree container. */
  private narrowObservation(): void {
    if (this.narrowed || this.observer === null) return;
    const localTree = this.observeTarget.matches(".nav-files-container")
      ? this.observeTarget
      : this.observeTarget.querySelector(".nav-files-container");
    const tree = localTree ?? document.querySelector(".nav-files-container");
    if (!(tree instanceof HTMLElement) || tree === this.observeTarget) {
      if (tree instanceof HTMLElement) this.narrowed = true;
      return;
    }
    this.observer.disconnect();
    this.observeTarget = tree;
    this.observer.observe(tree, { childList: true, subtree: true });
    this.narrowed = true;
  }

  private schedulePaint(): void {
    if (this.paintTimer !== null) return;
    this.paintTimer = this.setTimer(() => {
      this.paintTimer = null;
      this.paint();
    }, 120);
  }
  private readonly client = new MainInstanceClient("http://127.0.0.1:3080");
  private runningSessions = new Set<string>();

  constructor(private readonly plugin: DeepSeekHarnessPlugin) {}

  /** Attach after layout ready (the explorer leaf exists then). */
  attach(): void {
    if (this.attached) return;
    const leaves = this.plugin.app.workspace.getLeavesOfType("file-explorer");
    const leaf = leaves[0];
    if (leaf === undefined) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = leaf.view as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = view?.navigation as any;
    // Locate the explorer DOM: prefer the view's own elements, else the
    // known container class in the document.
    const candidates: Array<HTMLElement | undefined> = [
      view?.contentEl,
      view?.dom?.contentEl,
      view?.containerEl,
      nav?.containerEl,
      nav?.contentEl,
      nav?.dom?.contentEl,
      nav?.tree?.contentEl
    ];
    let container = candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
    if (container === undefined) {
      const byClass = document.querySelector(
        ".nav-files-container, .tree-container, .nav-tree, .workspace-leaf-content[data-type='file-explorer']"
      );
      if (byClass instanceof HTMLElement) container = byClass;
    }
    if (container === undefined) return;
    this.attached = true;
    // Observe only the file-tree container (not the whole document): the
    // tree may render asynchronously, so begin at the owning view container
    // and narrow to .nav-files-container once it exists.
    this.observer = new MutationObserver(() => this.schedulePaint());
    const treeContainer = document.querySelector(".nav-files-container");
    this.observeTarget = treeContainer instanceof HTMLElement ? treeContainer : container;
    this.observer.observe(this.observeTarget, { childList: true, subtree: true });
    // Once rows exist, move the observer to the tree container only.
    this.setTimer(() => this.narrowObservation(), 2_000);
    void this.refreshSessionStates();
    this.paint();
    // Retry a few times: the tree may render after the first paint.
    for (const delay of [1_000, 3_000, 8_000]) {
      this.setTimer(() => this.paint(), delay);
    }
    this.startSessionStateSubscription();
  }

  /** Switch from the one-shot HTTP baseline to the official live Session store. */
  bindSessionStateSource(source: GuiSessionStateSource): void {
    if (this.sessionStateSource === source && this.stopSessionStateSource !== null) return;
    this.stopSessionStateSource?.();
    this.stopSessionStateSource = null;
    this.sessionStateSource = source;
    this.sessionStateGeneration += 1;
    if (this.attached) this.startSessionStateSubscription();
  }

  private startSessionStateSubscription(): void {
    const source = this.sessionStateSource;
    if (source === null || this.stopSessionStateSource !== null) return;
    const generation = this.sessionStateGeneration;
    const apply = (): void => {
      if (!this.attached || generation !== this.sessionStateGeneration) return;
      this.applySessionStates(source.getSnapshot());
    };
    apply();
    this.stopSessionStateSource = source.subscribe(apply);
  }

  /** Click the native file-explorer tab header (delayed retries). */
  revealFileExplorerTab(...delays: number[]): void {
    for (const delay of delays) {
      this.setTimer(() => {
        const header = document.querySelector(
          '.workspace-tab-header[data-type="file-explorer"]'
        ) as HTMLElement | null;
        header?.click();
      }, delay);
    }
  }

  detach(): void {
    this.attached = false;
    this.sessionStateGeneration += 1;
    this.stopSessionStateSource?.();
    this.stopSessionStateSource = null;
    this.sessionStateSource = null;
    this.sessionStates.clear();
    this.observer?.disconnect();
    this.observer = null;
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    this.paintTimer = null;
    this.narrowed = false;
    this.observeTarget = document.body;
    this.painting = false;
    for (const badge of document.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
  }

  private async refreshSessionStates(): Promise<void> {
    const source = this.sessionStateSource;
    if (source !== null) {
      this.applySessionStates(source.getSnapshot());
      return;
    }
    const generation = this.sessionStateGeneration;
    try {
      const sessions = await this.client.listSessions();
      if (!this.attached || generation !== this.sessionStateGeneration) return;
      this.applySessionStates(sessions);
    } catch {
      // main instance unreachable — badges still show binding state
    }
  }

  private applySessionStates(sessions: readonly GuiSessionState[]): void {
    this.sessionStates = new Map(sessions.map((session) => [session.sessionId, session]));
    this.runningSessions = new Set(
      sessions.filter((session) => session.running && session.origin !== "subagent")
        .map((session) => session.sessionId)
    );
    this.paint();
  }

  private paint(): void {
    if (!this.attached || this.painting) return;
    this.painting = true;
    try {
      this.paintNow();
    } finally {
      this.painting = false;
    }
  }

  private paintNow(): void {
    for (const selector of ROW_SELECTORS) {
      const rows = this.observeTarget.querySelectorAll(selector);
      if (rows.length === 0) continue;
      for (const row of rows) {
        this.paintRow(row as HTMLElement);
      }
      return;
    }
  }

  private paintRow(row: HTMLElement): void {
    let badge = row.querySelector(`.${BADGE_CLASS}`) as HTMLElement | null;
    if (badge === null) {
      badge = document.createElement("span");
      badge.className = BADGE_CLASS;
      badge.setAttribute("role", "button");
      badge.tabIndex = 0;
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        void this.onBadgeClick(row, event);
      });
      badge.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.stopPropagation();
        event.preventDefault();
        void this.onBadgeClick(row, event);
      });
      row.appendChild(badge);
    }
    const path = this.pathForRow(row);
    const sessionIds = path === null ? [] : (this.plugin.settings.sessionsByPath[path] ?? []);
    const has = sessionIds.length > 0;
    const running = sessionIds.some((sessionId) => this.runningSessions.has(sessionId));
    const next = has ? String(sessionIds.length) : "＋";
    // Only write the DOM when the value actually changes — a blind write on
    // every paint keeps the renderer busy (style recalc per write).
    if (badge.textContent !== next) badge.textContent = next;
    badge.classList.toggle("has-session", has);
    badge.classList.toggle("running", has && running);
    if (path !== null && badge.getAttribute("data-path") !== path) {
      badge.setAttribute("data-path", path);
    }
    const label = path === null
      ? "DSH 会话（路径不可用）"
      : has
        ? sessionIds.length === 1
          ? `打开 ${path} 的 DSH 会话（${running ? "运行中" : "空闲"}）`
          : `选择 ${path} 的 DSH 会话（共 ${sessionIds.length} 个，${running ? "有会话运行中" : "全部空闲"}）`
        : `为 ${path} 新建 DSH 会话`;
    if (badge.getAttribute("aria-label") !== label) badge.setAttribute("aria-label", label);
    if (badge.getAttribute("title") !== label) badge.setAttribute("title", label);
  }

  private pathForRow(row: HTMLElement): string | null {
    const dataPath = row.getAttribute("data-path");
    if (dataPath !== null && dataPath !== "") return dataPath;
    // Fallback: first .tree-item-inner / .nav-file-title-content text with
    // ancestor paths is ambiguous — require data-path for now.
    return null;
  }

  private async onBadgeClick(row: HTMLElement, event: MouseEvent | KeyboardEvent): Promise<void> {
    const path = this.pathForRow(row);
    if (path === null) return;
    const sessionIds = this.plugin.settings.sessionsByPath[path] ?? [];
    if (sessionIds.length > 1) {
      const previews = await this.loadSessionPreviews(sessionIds);
      if (!this.attached) return;
      this.showSessionPicker(path, sessionIds, previews, row, event);
      return;
    }
    await this.plugin.openSessionForPath(path);
    await this.refreshSessionStates();
  }

  /**
   * Make a path's complete Session membership visible at the primary badge
   * interaction. This is an Obsidian-native menu; selecting a member still
   * opens the official DSH conversation in the right panel.
   */
  private showSessionPicker(
    path: string,
    sessionIds: readonly string[],
    previews: ReadonlyMap<string, string>,
    row: HTMLElement,
    event: MouseEvent | KeyboardEvent
  ): void {
    const target = this.plugin.app.vault.getAbstractFileByPath(path);
    const targetKind = target instanceof TFolder ? "目录" : "文件";
    const active = this.plugin.settings.sessionByPath[path];
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem((item) => item
      .setTitle(`绑定目标 · ${targetKind} · ${path}`)
      .setIcon(targetKind === "目录" ? "folder" : "file")
      .setIsLabel(true)
      .setSection("dsh-target"));
    for (const [index, sessionId] of sessionIds.entries()) {
      const state = this.sessionStates.get(sessionId);
      const officialTitle = state?.displayTitle ?? `DSH Session ${sessionId.slice(0, 8)}`;
      const preview = previews.get(sessionId);
      const running = state?.running === true;
      menu.addItem((item) => item
        .setTitle(
          `会话 ${index + 1}｜${officialTitle}` +
          `${preview === undefined ? " · 尚未对话" : `｜最近：${preview}`}` +
          `${running ? " · 运行中" : ""}`
        )
        .setIcon(running ? "loader-circle" : "message-circle")
        .setChecked(sessionId === active)
        .setSection("dsh-sessions")
        .onClick(async () => {
          await this.plugin.openSpecificSessionForPath(path, sessionId);
          await this.refreshSessionStates();
        }));
    }
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("新建另一个 DSH 会话")
      .setIcon("message-circle-plus")
      .setSection("dsh-create")
      .onClick(async () => {
        await this.plugin.createSessionForPath(path);
        await this.refreshSessionStates();
      }));
    if (event instanceof MouseEvent) {
      menu.showAtMouseEvent(event);
      return;
    }
    const rect = row.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.top });
  }

  private async loadSessionPreviews(sessionIds: readonly string[]): Promise<Map<string, string>> {
    const entries = await Promise.all(sessionIds.map(async (sessionId) => {
      try {
        const history = await this.client.history(sessionId);
        return [sessionId, this.latestVisibleUserText(history)] as const;
      } catch {
        return [sessionId, undefined] as const;
      }
    }));
    return new Map(entries.flatMap(([sessionId, preview]) =>
      preview === undefined ? [] : [[sessionId, preview]]
    ));
  }

  /** Exclude named system-context snapshots; show only the user's own prompt. */
  private latestVisibleUserText(history: HistoryPage): string | undefined {
    for (let index = history.events.length - 1; index >= 0; index -= 1) {
      const event = history.events[index]?.event;
      if (event?.type !== "user/message" || event.data.role !== "user" || event.data.source?.kind !== "user") {
        continue;
      }
      const text = event.data.content
        ?.filter((block) => block.type === "text" && block.name === undefined && typeof block.text === "string")
        .map((block) => block.text?.trim() ?? "")
        .filter((part) => part !== "")
        .join(" ");
      if (text === undefined || text === "") continue;
      const oneLine = text.replace(/\s+/g, " ");
      return oneLine.length <= 56 ? oneLine : `${oneLine.slice(0, 55)}…`;
    }
    return undefined;
  }
}
