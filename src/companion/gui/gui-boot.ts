/**
 * GUI boot — assembles the OFFICIAL DSH client plugin tree inside the
 * Obsidian plugin, exactly like the web shell does (window.__DSH_BOOT__
 * manifest + ClientModuleSystem + cordis Loader), with two substitutions:
 *
 *   1. module loading  → the official client entries ship as self-registering
 *      bundles (window.__ModuleLoader__.load). We ship those files next to the
 *      plugin (dist/plugins/...) and execute them via fs + vm at boot — no
 *      fetch, no CSP issues.
 *   2. connection      → provided by us over Node sockets (./transport), with
 *      the official service name "@deepseek-ai/dsh-client-connection" so
 *      api-gateway/runtime inject against the official contract.
 *
 * The rendered tree is the official app-shell (slot "root"): conversation /
 * trajectory / session log / slash-command menu / settings / runtime controls
 * are the exact components the Web GUI uses.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as Cordis from "@deepseek-ai/cordis";
import * as UiSlots from "@deepseek-ai/dsh-client-ui-slots";
import * as WebReact from "@deepseek-ai/dsh-client-web-react";
import { createSlotRenderer } from "@deepseek-ai/dsh-client-web-react";
import * as UiPrimitives from "@deepseek-ai/dsh-client-ui-primitives";
import * as UiAttachment from "@deepseek-ai/dsh-client-ui-attachment";
import * as SchemaForm from "@deepseek-ai/dsh-client-schema-form";
import officialDesignPlatformCss from "@deepseek-ai/dsh-client-ui-theme/styles/design-platform.css";

import type { AbstractApiClient as AbstractApiClientType } from "@deepseek-ai/dsh-client-connection/client";
import type { ClientModuleSystem as ClientModuleSystemType } from "@deepseek-ai/dsh-client-modules/client";
import { buildConnectionHandle, makeObsidianApiClient, type ApiClientCtor } from "./transport";
import { EmbeddedRoot, EmbeddedSettingsUtility } from "./embedded-root";

const APP_SHELL_ID = "@deepseek-ai/dsh-client-app-shell";
const MODULES_ID = "@deepseek-ai/dsh-client-modules";
/** Bundle id (manifest/modules row). */
const CONNECTION_BUNDLE_ID = "@deepseek-ai/dsh-client-connection";
/** Cordis service name the official plugins inject against (short name!). */
const CONNECTION_SERVICE = "connection";

/** Official client plugin ids shipped as bundles next to the plugin. The
 * connection row is in the graph (so modules.import can materialize the
 * AbstractApiClient base class) but its plugin is NOT loaded — we provide
 * the connection service ourselves over Node sockets. */
const BUNDLED_PLUGIN_IDS: string[] = [
  MODULES_ID,
  CONNECTION_BUNDLE_ID,
  "@deepseek-ai/dsh-typert-registry",
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-general",
  "@deepseek-ai/dsh-client-ui-settings-models",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-input-trigger",
  "@deepseek-ai/dsh-client-ui-commands",
  "@deepseek-ai/dsh-client-ui-model-selection",
  "@deepseek-ai/dsh-client-ui-permission-presets",
  "@deepseek-ai/dsh-client-ui-agent-preset",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
  "@deepseek-ai/dsh-client-ui-subagent",
  "@deepseek-ai/dsh-client-ui-jobs",
  "@deepseek-ai/dsh-client-ui-trajectory",
  "@deepseek-ai/dsh-client-ui-plan",
  "@deepseek-ai/dsh-client-ui-goal",
  "@deepseek-ai/dsh-client-ui-deliverables",
  "@deepseek-ai/dsh-session-log-export"
];

/** Platform seed table (same words as the web shell's getStaticModules). */
function getStaticModules(): Record<string, unknown> {
  return {
    "react": React,
    "react/jsx-runtime": ReactJsxRuntime,
    "react-dom": ReactDom,
    "react-dom/client": ReactDomClient,
    "@deepseek-ai/cordis": Cordis,
    "@deepseek-ai/dsh-client-ui-slots": UiSlots,
    "@deepseek-ai/dsh-client-web-react": WebReact,
    "@deepseek-ai/dsh-client-ui-primitives": UiPrimitives,
    "@deepseek-ai/dsh-client-ui-attachment": UiAttachment,
    "@deepseek-ai/dsh-client-schema-form": SchemaForm
  };
}

/** Boot manifest shaped like the host-injected window.__DSH_BOOT__. */
function buildManifest(): {
  rev: string;
  modules: Array<{ id: string; url: string; rev: string }>;
  plugins: Array<{ id: string; inject: string[]; immediately: boolean }>;
} {
  const entries = BUNDLED_PLUGIN_IDS.map((id) => ({
    id,
    url: `/plugins/${id}/client.js?rev=static`,
    rev: "static",
    inject: [] as string[],
    immediately: id === "@deepseek-ai/dsh-typert-registry"
  }));
  return {
    rev: "obsidian-embed-1",
    modules: entries.map(({ id, url, rev }) => ({ id, url, rev })),
    plugins: entries.map(({ id, inject, immediately }) => ({ id, inject, immediately }))
  };
}

/** Execute one bundled client entry via vm (self-registers its factory). */
function executeBundle(pluginDir: string, id: string): void {
  const file = join(pluginDir, "plugins", id, "client.js");
  const code = readFileSync(file, "utf8");
  vm.runInThisContext(code, { filename: `dsh-embed://${id}/client.js` });
}

/** Static loader hook: read the shipped bundle and execute it (no fetch). */
function makeStaticLoadBundle(pluginDir: string): (url: string) => Promise<void> {
  const log = (message: string): void => {
    try {
      appendFileSync(join(pluginDir, "gui-boot.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // ignore
    }
  };
  return async (url: string) => {
    const id = url.replace("/plugins/", "").split("/client.js")[0] as string;
    log(`loadBundle: ${id}`);
    try {
      executeBundle(pluginDir, id);
      log(`loadBundle ok: ${id}`);
    } catch (error) {
      log(`loadBundle FAILED: ${id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      throw error;
    }
  };
}

interface TempLoaderHandoff {
  id: string;
  factory: (require: (spec: string) => unknown) => unknown;
}

/** Load the module-system implementation itself (bootstrap exception). */
function loadClientModuleSystem(pluginDir: string): {
  ClientModuleSystem: typeof ClientModuleSystemType;
  modulesFactory: TempLoaderHandoff["factory"];
} {
  const tempFactories = new Map<string, TempLoaderHandoff["factory"]>();
  (globalThis as { __ModuleLoader__?: { load: (h: TempLoaderHandoff) => void } }).__ModuleLoader__ = {
    load: (handoff) => {
      tempFactories.set(handoff.id, handoff.factory);
    }
  };
  executeBundle(pluginDir, MODULES_ID);
  const factory = tempFactories.get(MODULES_ID);
  if (factory === undefined) throw new Error("gui-boot: modules bundle did not register its factory");
  // The modules bundle is self-contained (no cross-package requires).
  const exports = factory((spec) => {
    throw new Error(`gui-boot: modules bundle unexpectedly requires "${spec}"`);
  }) as { ClientModuleSystem: typeof ClientModuleSystemType };
  if (typeof exports.ClientModuleSystem !== "function") {
    throw new Error("gui-boot: modules bundle did not export ClientModuleSystem");
  }
  // Clear the bootstrap loader: ClientModuleSystem's constructor installs its
  // own __ModuleLoader__ and rejects when one already exists.
  delete (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__;
  return { ClientModuleSystem: exports.ClientModuleSystem, modulesFactory: factory };
}

// ── app-shell (kernel-owned pseudo entry; mirrors the web shell's) ─────────

const appShellExports = {
  name: "app-shell",
  inject: ["slots", "sessions"],
  apply: async (ctx: Context) => {
    const log = (message: string): void => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__DSH_GUI_LOG__?.(message);
      } catch {
        // ignore
      }
    };
    log("app-shell apply start");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).slots.install(createSlotRenderer());
    log("slots installed");
    // Embedded layout: replace the official ui-layout root registration
    // (AppFrame three-column frame) with a container-aware root that renders
    // per-panel slots — plus the "layout" service the other plugins inject.
    await registerEmbeddedRoot(ctx, log);
    log("embedded root registered");
    let renderApp: (() => React.ReactNode) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx as any).reflect.provide("appShell", {
      renderApp: () => {
        renderApp ??= (() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (ctx as any).slots.renderSlot("root", {}) as React.ReactNode;
        });
        return renderApp();
      }
    });
    log("appShell provided");
  }
};

/** Minimal LayoutController face (same actions as the official one). */
interface EmbeddedLayoutController {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _actions: any;
  attachPanels(actions: unknown): void;
  toggleSidebar(): void;
  openDetails(): void;
  closeDetails(): void;
}

/**
 * Provide the "layout" service and register the container-aware root entry.
 * Requires the runtime (for defineStore) and slots — called from the
 * app-shell apply, which runs after the runtime has mounted.
 */
async function registerEmbeddedRoot(ctx: Context, log: (message: string) => void): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modules = (globalThis as any).__DSH_MODULES__ as { import(spec: string): Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtimeExports = (await modules.import("@deepseek-ai/dsh-client-runtime")) as any;
  const defineStore = runtimeExports.defineStore as (desc: unknown) => unknown;

  const layout: EmbeddedLayoutController = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _actions: null as any,
    attachPanels(actions: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._actions = actions;
    },
    toggleSidebar() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._actions?.toggleSidebar?.();
    },
    openDetails() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._actions?.openDetails?.();
    },
    closeDetails() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._actions?.closeDetails?.();
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).reflect.provide("layout", layout);
  log("layout service provided");

  const store = () => defineStore({
    init: () => ({ sidebar: 280, details: 0, narrow: false, narrowExpanded: false }),
    actions: {
      setSidebar: (d: { sidebar: number }, px: number) => {
        d.sidebar = Math.min(420, Math.max(264, Math.round(px)));
      },
      setDetails: (d: { details: number }, px: number) => {
        d.details = Math.min(520, Math.max(300, Math.round(px)));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toggleSidebar: (d: any) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded;
        else d.sidebar = d.sidebar === 0 ? 280 : 0;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setNarrow: (d: any, narrow: boolean) => {
        if (d.narrow === narrow) return;
        d.narrow = narrow;
        d.narrowExpanded = false;
      },
      openDetails: (d: { details: number }) => {
        if (d.details === 0) d.details = 360;
      },
      closeDetails: (d: { details: number }) => {
        d.details = 0;
      }
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).slots.register({
    name: "root",
    children: {
      "conversation": { kind: "single", scope: "session-maybe" },
      "details": { kind: "single", scope: "session" },
      "shell.overlay": { kind: "list", scope: "root" },
      "sidebar.settings": { kind: "single", scope: "root" }
    },
    store,
    inject: (actions: unknown) => {
      layout.attachPanels(actions);
      return {};
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }, EmbeddedRoot as any);
  log("root entry registered");

  // Put SettingsRoot in the same official header utility row as Session log.
  // The settings seat is root-owned so the same official control can also be
  // rendered when there is no current Session and therefore no header row.
  (ctx as any).slots.inject("conversation.session.header.utilities", () =>
    (ctx as any).slots.register({
      name: "conversation.session.header.utilities",
      id: "embedded-settings",
      order: -10
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }, EmbeddedSettingsUtility as any)
  );
  log("embedded settings header utility registered");
}

// ── light-theme handling ───────────────────────────────────────────────────
// The Obsidian page has NO design-platform.css / base.css (those ship only
// in the web build assets), so the --dsw-* tokens painted inline by the
// official theme presenter are the ONLY variable source for the embedded
// UI. Deleting them breaks text/hover rendering (the composer input draws
// transparent text mirrored through a backdrop layer that reads
// --dsw-alias-label-primary).
//
// Correct approach: force the theme preference to "light" (publish a light
// snapshot → the presenter paints LIGHT tokens), and keep a minimal guard
// that only pins the document color scheme to light (Obsidian is light).
function installLightThemeGuard(): () => void {
  const cleanup = (): void => {
    try {
      // Only write when the value actually differs — a blind write triggers
      // the style MutationObserver and creates a self-sustaining loop.
      if (document.documentElement.style.colorScheme !== "light") {
        document.documentElement.style.colorScheme = "light";
      }
    } catch {
      // ignore
    }
  };
  cleanup();
  const observer = new MutationObserver(() => cleanup());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  return () => observer.disconnect();
}

/**
 * Official feature bundles inject their own CSS under data-plugin-css. The
 * rules are correct for the WebGUI, but Obsidian's global element selectors
 * can outrank a one-class module selector. Mirror those exact rules with one
 * `body` ancestor so the embedded client keeps its native cascade. This does
 * not invent component styles or modify any declaration.
 */
function installOfficialStyleSpecificity(): () => void {
  const isolation = document.createElement("style");
  isolation.setAttribute("data-dsh-official-specificity", "rc.6");
  document.head.appendChild(isolation);
  let lastCss = "";
  let scheduled = false;

  const rebuild = (): void => {
    scheduled = false;
    const chunks: string[] = [];
    for (const node of Array.from(document.head.children)) {
      if (!(node instanceof HTMLStyleElement) || !node.hasAttribute("data-plugin-css")) continue;
      const sheet = node.sheet;
      if (sheet === null) continue;
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          const scoped = scopeOfficialCssRule(rule);
          if (scoped !== "") chunks.push(scoped);
        }
      } catch {
        // Inline official sheets are readable; fail soft if Electron changes.
      }
    }
    const css = chunks.join("\n");
    if (css !== lastCss) {
      isolation.textContent = css;
      lastCss = css;
    }
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(rebuild);
  };
  const observer = new MutationObserver((records) => {
    const hasOfficialStyle = records.some((record) =>
      Array.from(record.addedNodes).some((node) =>
        node instanceof HTMLStyleElement && node.hasAttribute("data-plugin-css")
      )
    );
    if (hasOfficialStyle) schedule();
  });
  observer.observe(document.head, { childList: true });
  rebuild();

  return () => {
    observer.disconnect();
    isolation.remove();
  };
}

function scopeOfficialCssRule(rule: CSSRule): string {
  if (rule.type === CSSRule.KEYFRAMES_RULE) return "";
  if (rule instanceof CSSStyleRule) {
    const selectors = splitCssSelectorList(rule.selectorText)
      .map((selector) => scopeOfficialSelector(selector))
      .join(",");
    return `${selectors}{${rule.style.cssText}}`;
  }
  if ("cssRules" in rule) {
    const group = rule as CSSRule & { cssRules: CSSRuleList };
    const headerEnd = rule.cssText.indexOf("{");
    if (headerEnd < 0) return "";
    const nested = Array.from(group.cssRules)
      .map((child) => scopeOfficialCssRule(child))
      .filter((css) => css !== "")
      .join("\n");
    return nested === "" ? "" : `${rule.cssText.slice(0, headerEnd)}{${nested}}`;
  }
  return "";
}

function scopeOfficialSelector(selector: string): string {
  const trimmed = selector.trim();
  return /^(?:body|html|:root)(?:\b|\[|\.|#|:)/.test(trimmed)
    ? trimmed
    : `body ${trimmed}`;
}

/** Split only top-level commas; functional pseudo-classes may contain lists. */
function splitCssSelectorList(selectors: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let roundDepth = 0;
  let squareDepth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < selectors.length; index += 1) {
    const char = selectors[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (char === "," && roundDepth === 0 && squareDepth === 0) {
      parts.push(selectors.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selectors.slice(start));
  return parts;
}

interface EmbeddedThemeSnapshot {
  active: {
    colorScheme: "light" | "dark";
    tokens: Record<string, string>;
  };
}

/**
 * rc.6 keeps its built-in light/dark ThemeRuntime snapshots intentionally
 * empty: the normal WebGUI receives the base palette from
 * design-platform.css. Obsidian does not load that stylesheet, so project the
 * official light `body { --dsw-* }` declarations into the inline presenter
 * before applying any runtime override tokens.
 */
function parseOfficialLightTokens(css: string): Readonly<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const block of css.matchAll(/body\s*\{([^}]*)}/g)) {
    const declarations = block[1] ?? "";
    for (const declaration of declarations.matchAll(/(--dsw-[\w-]+)\s*:\s*([^;]+);/g)) {
      const name = declaration[1];
      const value = declaration[2]?.trim();
      if (name !== undefined && value !== undefined && value !== "") tokens[name] = value;
    }
  }
  if (tokens["--dsw-alias-label-primary"] === undefined || tokens["--dsw-specific-menu"] === undefined) {
    throw new Error("gui-boot: official light theme tokens are incomplete");
  }
  return Object.freeze(tokens);
}

const OFFICIAL_LIGHT_TOKENS = parseOfficialLightTokens(officialDesignPlatformCss);

/**
 * The official ThemePresenter lives inside ui-layout, which the embedded root
 * cannot load because that plugin also registers the full three-column
 * AppFrame. Preserve the presenter half of the rc.6 contract here: consume the
 * official theme snapshot and project every token unchanged onto body.
 */
function installEmbeddedThemePresenter(ctx: Context): () => void {
  const theme = (ctx as any).reflect.get("theme", false) as
    | { getTheme?: () => EmbeddedThemeSnapshot }
    | undefined;
  if (theme === undefined || typeof theme.getTheme !== "function") return () => undefined;
  let appliedTokens: string[] = [];
  let currentTokens: Record<string, string> = {};
  const ensureTokens = (): void => {
    const body = document.body;
    for (const [name, value] of Object.entries(currentTokens)) {
      if (body.style.getPropertyValue(name) !== value) body.style.setProperty(name, value);
    }
  };
  const apply = (snapshot: EmbeddedThemeSnapshot): void => {
    const body = document.body;
    for (const name of appliedTokens) body.style.removeProperty(name);
    appliedTokens = [];
    currentTokens = { ...OFFICIAL_LIGHT_TOKENS, ...snapshot.active.tokens };
    for (const [name, value] of Object.entries(currentTokens)) {
      body.style.setProperty(name, value);
      appliedTokens.push(name);
    }
  };
  apply(theme.getTheme());
  const observer = new MutationObserver(() => ensureTokens());
  observer.observe(document.body, { attributes: true, attributeFilter: ["style"] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const off = (ctx as any).on("theme/change", apply) as () => void;
  return () => {
    observer.disconnect();
    off();
    for (const name of appliedTokens) document.body.style.removeProperty(name);
    appliedTokens = [];
    currentTokens = {};
  };
}

/** Force the theme runtime to the light palette (inline tokens stay). */
function forceLightTheme(ctx: Context): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const theme = (ctx as any).reflect.get("theme", false) as
    | { preference?: string; publish?: () => void }
    | undefined;
  if (theme === undefined || typeof theme.publish !== "function") return;
  theme.preference = "light";
  theme.publish();
}

// ── boot ───────────────────────────────────────────────────────────────────

export interface GuiHandle {
  /** Render the official root slot (AppFrame). */
  renderSlot(key: string, props?: unknown): React.ReactNode;
  /** Layout panel actions (sidebar/details toggles). */
  layout: {
    toggleSidebar(): void;
    openDetails(): void;
    closeDetails(): void;
  };
  /** Open a session by id (right panel follows via the sessions store). */
  openSession(sessionId: string): Promise<void>;
  /** Official New-Session flow: reuse/create the workspace's session. */
  connectWorkspace(workspaceId: string): Promise<string>;
  /** Re-pull the workspace list so new sessions resolve a chip title. */
  refreshWorkspaces(): Promise<void>;
  /** Live official Session-list projection for path badges (never rendered as a list). */
  sessionStates: GuiSessionStateSource;
  dispose: () => void;
}

export interface GuiSessionState {
  sessionId: string;
  /** Present on the official Client store; HTTP cold baseline may omit it. */
  displayTitle?: string;
  running: boolean;
  /** Durable official list facts used by the native standalone workbench. */
  updatedAt?: number;
  blank?: boolean;
  completed?: boolean;
  origin?: "subagent";
}

export interface GuiSessionStateSource {
  getSnapshot(): readonly GuiSessionState[];
  subscribe(listener: () => void): () => void;
}

/**
 * Boot the official DSH client plugin tree (single instance per plugin).
 * Does NOT render anything — views call renderSlot(key) on their own roots.
 * @param baseUrl - main instance base URL (e.g. http://127.0.0.1:3080).
 * @param pluginDir - absolute path of the plugin directory (bundles live at
 *   <pluginDir>/plugins/<pkg>/client.js).
 */
export async function startGui(baseUrl: string, pluginDir: string): Promise<GuiHandle> {
  const log = (message: string): void => {
    try {
      appendFileSync(join(pluginDir, "gui-boot.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // logging must never break boot
    }
  };
  log("mountGui start");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__DSH_GUI_LOG__ = log;
  // 1. module system (bootstrap: modules bundle first, then install)
  const { ClientModuleSystem, modulesFactory } = loadClientModuleSystem(pluginDir);
  log("ClientModuleSystem loaded");
  try {
    const manifest = buildManifest();
    const modules = new ClientModuleSystem({
      modules: manifest.modules,
      staticModules: getStaticModules(),
      loadBundle: makeStaticLoadBundle(pluginDir)
    });
    log("ClientModuleSystem constructed");
    (globalThis as { __DSH_MODULES__?: unknown }).__DSH_MODULES__ = modules;
    // Re-register the modules bundle factory under the real loader (its graph
    // row is loaded like any other plugin).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__ModuleLoader__?.load({ id: MODULES_ID, factory: modulesFactory });
    log("modules factory registered");

    // 2. app-shell pseudo entry (factory form, no bundle file)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__ModuleLoader__?.load({ id: APP_SHELL_ID, factory: () => appShellExports });
    log("app-shell registered");

    // 3. cordis ctx (no cordis-plugin-loader: its ESM import.meta cannot run
    //    under the plugin's CJS bundle; cordis 4 Fiber handles inject waiting)
    const ctx = new Context();
    log("ctx created");
    return await mountRest(ctx, modules, baseUrl, pluginDir, log);
  } catch (error) {
    log(`FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    throw error;
  }
}

async function mountRest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  modules: ClientModuleSystemType,
  baseUrl: string,
  pluginDir: string,
  log: (message: string) => void
): Promise<GuiHandle> {
  // 4. connection service (official contract, Node transport)
  log(`importing ${CONNECTION_BUNDLE_ID}`);
  const connectionExports = (await modules.import(CONNECTION_BUNDLE_ID)) as {
    AbstractApiClient: ApiClientCtor;
  };
  if (typeof connectionExports.AbstractApiClient !== "function") {
    throw new Error("gui-boot: connection bundle did not export AbstractApiClient");
  }
  log("connection bundle imported");
  const ObsidianApi = makeObsidianApiClient(connectionExports.AbstractApiClient, baseUrl);
  ctx.provide(CONNECTION_SERVICE, buildConnectionHandle(ObsidianApi, baseUrl));

  // 5. load every plugin through ctx.plugin (cordis Fiber resolves each
  //    plugin's inject list). Order matters at three seams:
  //    - runtime before app-shell (slots/sessions),
  //    - app-shell before the UI plugins (it provides "layout" + registers
  //      the embedded root entry),
  //    - everything else follows.
  log("connection provided; loading plugins");
  const PLUGIN_IDS = BUNDLED_PLUGIN_IDS.filter(
    (id) => id !== MODULES_ID && id !== CONNECTION_BUNDLE_ID
  );
  const order = [
    MODULES_ID,
    "@deepseek-ai/dsh-typert-registry",
    "@deepseek-ai/dsh-api-gateway",
    "@deepseek-ai/dsh-api-remotes",
    "@deepseek-ai/dsh-client-runtime",
    APP_SHELL_ID,
    ...PLUGIN_IDS.filter((id) =>
      id !== "@deepseek-ai/dsh-typert-registry" &&
      id !== "@deepseek-ai/dsh-api-gateway" &&
      id !== "@deepseek-ai/dsh-api-remotes" &&
      id !== "@deepseek-ai/dsh-client-runtime"
    )
  ];
  for (const id of order) {
    log(`plugin: ${id}`);
    const mod = id === APP_SHELL_ID
      ? appShellExports
      : await modules.import(id);
    try {
      await ctx.plugin(mod);
      log(`plugin active: ${id}`);
    } catch (error) {
      log(`plugin FAILED: ${id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      throw error;
    }
  }
  log("all plugins loaded");

  // 5b. keep the embedded UI light (follows Obsidian, not the system theme)
  forceLightTheme(ctx);
  log("light theme forced");
  const stopThemePresenter = installEmbeddedThemePresenter(ctx);
  log("theme tokens presented");
  const stopThemeGuard = installLightThemeGuard();
  const stopStyleSpecificity = installOfficialStyleSpecificity();
  log("official style specificity isolated");

  const sessions = (ctx as any).sessions as {
    open(id: string): void;
    list: {
      getSnapshot(): {
        ids: string[];
        byId: Record<string, {
          displayTitle: string;
          running: boolean;
          updatedAt: number;
          blank: boolean;
          completed?: boolean;
          origin?: "subagent";
        }>;
        current?: string;
        phase?: string;
      };
      subscribe(listener: () => void): () => void;
    };
  };
  const sessionStates: GuiSessionStateSource = {
    getSnapshot: () => {
      const snapshot = sessions.list.getSnapshot();
      return snapshot.ids.flatMap((sessionId): GuiSessionState[] => {
        const summary = snapshot.byId[sessionId];
        if (summary === undefined) return [];
        const state: GuiSessionState = {
          sessionId,
          displayTitle: summary.displayTitle,
          running: summary.running,
          updatedAt: summary.updatedAt,
          blank: summary.blank,
          ...(summary.completed === undefined ? {} : { completed: summary.completed })
        };
        return [summary.origin === "subagent" ? { ...state, origin: "subagent" } : state];
      });
    },
    subscribe: (listener) => sessions.list.subscribe(listener)
  };

  const pendingSessionOpens = new Map<string, Promise<void>>();
  const openSessionOnce = (sessionId: string): Promise<void> => {
    const current = sessions.list.getSnapshot();
    if (current.current === sessionId) return Promise.resolve();
    if (current.ids.includes(sessionId)) {
      sessions.open(sessionId);
      return Promise.resolve();
    }
    if (current.phase === "ready") {
      return Promise.reject(new Error(`DSH 会话不存在：${sessionId}`));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        unsubscribe?.();
        if (error === undefined) resolve();
        else reject(error);
      };
      const reconcile = (): void => {
        const snapshot = sessions.list.getSnapshot();
        if (snapshot.ids.includes(sessionId)) {
          sessions.open(sessionId);
          finish();
        } else if (snapshot.phase === "ready") {
          finish(new Error(`DSH 会话不存在：${sessionId}`));
        }
      };
      // A mature 3080 instance can carry hundreds of sessions (including
      // subagents). Its first official list pull can legitimately exceed ten
      // seconds on cold start, so keep the UI quiet while that authoritative
      // baseline arrives and fail only after a bounded 30-second wait.
      const timer = window.setTimeout(() => finish(new Error("等待 DSH 会话列表超时")), 30_000);
      unsubscribe = sessions.list.subscribe(reconcile);
      reconcile();
    });
  };
  const openSession = (sessionId: string): Promise<void> => {
    const pending = pendingSessionOpens.get(sessionId);
    if (pending !== undefined) return pending;
    const operation = openSessionOnce(sessionId);
    pendingSessionOpens.set(sessionId, operation);
    const forget = (): void => {
      if (pendingSessionOpens.get(sessionId) === operation) pendingSessionOpens.delete(sessionId);
    };
    void operation.then(forget, forget);
    return operation;
  };

  // 6. renderer installed by the app-shell plugin; views render their own
  //    slots via renderSlot (the official app-shell renderApp renders the
  //    full three-column frame — the embedded layout composes slots instead).
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderSlot: (key: string, props?: unknown): React.ReactNode => (ctx as any).slots.renderSlot(key, props ?? {}),
    layout: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toggleSidebar: () => (ctx as any).layout?.toggleSidebar?.(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openDetails: () => (ctx as any).layout?.openDetails?.(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      closeDetails: () => (ctx as any).layout?.closeDetails?.()
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    openSession,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connectWorkspace: (workspaceId: string) => (ctx as any).workspaces?.connectWorkspace?.(workspaceId) as Promise<string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refreshWorkspaces: () => (ctx as any).workspaces?.refresh?.() as Promise<void>,
    sessionStates,
    dispose: () => {
      stopStyleSpecificity();
      stopThemeGuard();
      stopThemePresenter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (ctx as any).dispose();
    }
  };
}

/** Re-export for callers that need the node transport (kept minimal). */
export { nodeFetchCompat } from "./transport";
export type { AbstractApiClientType };
