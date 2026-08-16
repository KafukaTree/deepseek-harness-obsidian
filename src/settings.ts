import { App, PluginSettingTab, Setting } from "obsidian";
import type DeepSeekHarnessPlugin from "./main";
import {
  DEFAULT_STANDALONE_GROUP_ID,
  DEFAULT_STANDALONE_GROUP_NAME,
  standaloneSessionIds,
  type StandaloneSessionGroup
} from "./state/standalone-session-map";

/** Active settings for the single 3080 embedded-GUI product. */
export interface DeepSeekHarnessSettings {
  /** Stable identity for this Vault's DSH target namespace. */
  vaultId: string;
  /** Every DSH Session owned by one Obsidian file/folder path. */
  sessionsByPath: Record<string, string[]>;
  /** Current/default Session per path (compatibility name retained for legacy code). */
  sessionByPath: Record<string, string>;
  /** Stable target identity; moved on rename and retired on delete. */
  targetIdByPath: Record<string, string>;
  /** Last authoritative Obsidian type, retained long enough to log deletes. */
  targetKindByPath: Record<string, "file" | "folder">;
  /** Path-free Sessions grouped like folders in the native AI workbench. */
  standaloneSessionGroups: StandaloneSessionGroup[];
  /** Current/default path-free Session, or null when the workbench is empty. */
  activeStandaloneSessionId: string | null;
  /** Optional DSH file workspace inherited by new standalone Sessions. */
  standaloneWorkspaceId: string | null;
  /** Open the official DSH right panel after Obsidian restores its layout. */
  openMainSessionOnLoad: boolean;
}

export const DEFAULT_SETTINGS: DeepSeekHarnessSettings = {
  vaultId: "",
  sessionsByPath: {},
  sessionByPath: {},
  targetIdByPath: {},
  targetKindByPath: {},
  standaloneSessionGroups: [{
    groupId: DEFAULT_STANDALONE_GROUP_ID,
    name: DEFAULT_STANDALONE_GROUP_NAME,
    sessionIds: []
  }],
  activeStandaloneSessionId: null,
  standaloneWorkspaceId: null,
  openMainSessionOnLoad: false
};

export class DeepSeekHarnessSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DeepSeekHarnessPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "DeepSeek Harness" });

    new Setting(containerEl)
      .setName("DSH 主界面")
      .setDesc("固定嵌入本机 3080 主实例，作为插件内唯一的 DSH 界面。")
      .addButton((button) => {
        button.setButtonText("打开右栏").onClick(() => void this.plugin.activateMainSession());
      });

    new Setting(containerEl)
      .setName("启动时打开 DSH 右栏")
      .setDesc("关闭时仍可通过左侧文件树徽标、Ribbon 或命令打开。")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.openMainSessionOnLoad).onChange(async (value) => {
          this.plugin.settings.openMainSessionOnLoad = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("按知识对象绑定的会话")
      .setDesc(
        `当前有 ${Object.keys(this.plugin.settings.sessionsByPath).length} 个文件或文件夹、` +
        `${Object.values(this.plugin.settings.sessionsByPath).reduce((sum, ids) => sum + ids.length, 0)} 个内容会话，` +
        `${standaloneSessionIds(this.plugin.settings.standaloneSessionGroups).length} 个独立会话。`
      );
  }
}
