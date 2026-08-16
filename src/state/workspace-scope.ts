import { dirname, join, resolve } from "node:path";

/**
 * A folder target is its own DSH file workspace. A file target belongs to the
 * workspace represented by its parent folder; root files belong to the Vault.
 */
export function targetWorkspacePath(
  vaultRoot: string,
  targetPath: string,
  kind: "file" | "folder"
): string {
  const relativeDirectory = kind === "folder" ? targetPath : dirname(targetPath);
  return resolve(join(vaultRoot, relativeDirectory === "." ? "" : relativeDirectory));
}
