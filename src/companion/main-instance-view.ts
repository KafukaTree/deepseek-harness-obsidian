/**
 * DSH 会话视图 — the right-sidebar host for the official DSH client tree.
 * Obsidian owns the ItemView seat; conversation, composer, Session log and
 * trajectory remain the official dsh-client-ui-* components.
 */

import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import * as React from "react";
import type DeepSeekHarnessPlugin from "../main";
import { MainInstanceError } from "./main-instance-client";

export const DSH_MAIN_SESSION_VIEW_TYPE = "dsh-main-session";

export class MainInstanceView extends ItemView {
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: DeepSeekHarnessPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return DSH_MAIN_SESSION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "DSH 会话";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("dsh-right-panel");
    const host = root.createDiv({ cls: "dsh-right-panel-host" });
    try {
      const gui = await this.plugin.getGuiInstance();
      this.root = createRoot(host);
      // EmbeddedRoot exposes only official conversation/details slots.
      this.root.render(
        React.createElement("div", { className: "dsh-right-frame" },
          gui.renderSlot("root")
        )
      );
    } catch (error) {
      host.empty();
      host.createDiv({
        text: `DSH 界面挂载失败：${errorMessage(error)}`,
        cls: "dsh-main-session-empty dsh-main-session-err"
      });
      new Notice("DSH 会话面板挂载失败（详见面板错误）");
    }
  }

  onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
    return Promise.resolve();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof MainInstanceError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
