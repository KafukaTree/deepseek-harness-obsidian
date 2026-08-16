/**
 * EmbeddedRoot — replaces the official AppFrame root component for the
 * embedded layout. Obsidian owns the left file tree; this root renders only
 * the official right-side slot set:
 *
 *   right panel (.dsh-right-panel-host) → conversation + details + overlay
 *
 * This avoids both the official global-session sidebar and a duplicated
 * three-column AppFrame while keeping the conversation/details components
 * sourced from the official client bundles.
 */

import * as React from "react";

type RenderSlot = (key: string, props?: unknown) => React.ReactNode;

const settingsUtilityListeners = new Set<() => void>();
let settingsUtilityMounts = 0;

function subscribeSettingsUtility(listener: () => void): () => void {
  settingsUtilityListeners.add(listener);
  return () => settingsUtilityListeners.delete(listener);
}

function settingsUtilityMounted(): boolean {
  return settingsUtilityMounts > 0;
}

function publishSettingsUtilityPresence(): void {
  for (const listener of settingsUtilityListeners) listener();
}

export interface EmbeddedRootProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  renderSlot: RenderSlot;
  /** Bound store hook injected by slots.register (layout panel state). */
  useStore?: (selector: (state: unknown) => unknown) => unknown;
}

/**
 * Session-header utility that owns the embedded declaration of the official
 * SettingsRoot seat. It is registered beside Session log through the public
 * conversation header slot; the settings trigger and modal remain official.
 */
export function EmbeddedSettingsUtility({ renderSlot }: EmbeddedRootProps): React.ReactElement {
  React.useEffect(() => {
    settingsUtilityMounts += 1;
    publishSettingsUtilityPresence();
    return () => {
      settingsUtilityMounts = Math.max(0, settingsUtilityMounts - 1);
      publishSettingsUtilityPresence();
    };
  }, []);
  return React.createElement(
    "div",
    { className: "dsh-embedded-settings-utility" },
    renderSlot("sidebar.settings", { wide: true })
  );
}

export function EmbeddedRoot({ renderSlot, useStore }: EmbeddedRootProps): React.ReactElement {
  // Details follows the layout store (0 = closed, like the official frame):
  // the panel only appears when a tool row opens it and hides on close.
  // Narrow selector: subscribing to the whole store re-renders the entire
  // slot tree on ANY layout change.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details = (useStore !== undefined ? useStore((s: any) => s.details) : undefined) as number | undefined;
  const detailsOpen = (details ?? 0) > 0;
  const headerSettingsMounted = React.useSyncExternalStore(
    subscribeSettingsUtility,
    settingsUtilityMounted,
    settingsUtilityMounted
  );

  return React.createElement(
    "div",
    { className: "dsh-embedded-main" },
    !headerSettingsMounted
      ? React.createElement(
        "div",
        { className: "dsh-embedded-settings-fallback" },
        renderSlot("sidebar.settings", { wide: true })
      )
      : null,
    React.createElement("div", { className: "dsh-embedded-conversation" }, renderSlot("conversation")),
    detailsOpen
      ? React.createElement("div", { className: "dsh-embedded-details" }, renderSlot("details"))
      : null,
    renderSlot("shell.overlay")
  );
}
