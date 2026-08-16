/**
 * Main-instance fetch-carrier client — the control plane for the embedded
 * DSH Companion panel.
 *
 * Talks the SAME wire protocol as the Web GUI (M0-verified against the live
 * 3080 instance): POST {base}/api/{method} with
 *   {"type":"client-request","rpcId":<uuid>,"method":"session.list","payload":{...}}
 * and receives
 *   {"type":"server-response","rpcId":<uuid>,"result":{"ok":true,"value":...}}
 * Loopback is token-free (verified: session.list / session.history /
 * session.models / commands/execute all answer unauthenticated on 127.0.0.1).
 *
 * Transport is Node http (NOT browser fetch): Obsidian's renderer CSP blocks
 * fetch to non-self origins, while Node sockets bypass CSP entirely — same
 * choice as the existing DshClient (bridge/dsh-client.ts), which connects to
 * the sidecar over node:http + ws.
 */

import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  projections?: {
    values?: {
      title?: unknown;
      [key: string]: unknown;
    };
  };
}

export interface ObsidianTargetBinding {
  protocolVersion: 1;
  sessionId: string;
  vaultId: string;
  targetId: string;
  kind: "file" | "folder";
  path: string;
  state: "active" | "deleted";
}

export interface WorkspaceSummary {
  workspaceId: string;
  path: string;
  title?: string;
  sessionIds: string[];
}

export interface ModelOption {
  id: string;
  name: string;
  reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort: string };
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

export interface ModelsCatalog {
  current: { provider: string; model: string; reasoningEffort?: string } | null;
  routable: boolean;
  groups: ModelGroup[];
  failures?: unknown[];
}

export interface HistoryBlock {
  type: string;
  text?: string;
  name?: string;
  arguments?: string;
  toolCallId?: string;
  [key: string]: unknown;
}

/**
 * One session.history item — the session event plus its optional
 * host-computed tool view (verified against the live wire: the entry nests
 * under `event`, mirroring historyEntrySchema).
 */
export interface HistoryEntry {
  event: {
    seq: number;
    time: number;
    type: string;
    data: {
      turn?: number;
      step?: number;
      role?: string;
      content?: HistoryBlock[];
      source?: { kind?: string; [key: string]: unknown };
      message?: { role: string; content?: HistoryBlock[] };
      callId?: string;
      name?: string;
      arguments?: string;
      active?: boolean;
      [key: string]: unknown;
    };
  };
  view?: unknown;
}

export interface HistoryPage {
  events: HistoryEntry[];
  hasMore: boolean;
}

export interface CommandResult {
  commandId: string;
  result: { kind: string; text?: string };
}

interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
}

export class MainInstanceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MainInstanceError";
  }
}

export class MainInstanceClient {
  constructor(private readonly baseUrl: string) {}

  /** One unary call over the HTTP carrier (Node transport, CSP-exempt). */
  private call(
    method: string,
    payload: unknown,
    timeoutMs = 20_000,
    signal?: AbortSignal
  ): Promise<unknown> {
    const rpcId = randomUUID();
    const url = new URL(`${this.baseUrl}/api/${method}`);
    const body = JSON.stringify({ type: "client-request", rpcId, method, payload });
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port === "" ? undefined : Number(url.port),
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
              finish(() => reject(new MainInstanceError(
                "transport",
                `主实例 /api/${method} 返回 HTTP ${res.statusCode}`
              )));
              return;
            }
            let frame: ServerResponse;
            try {
              frame = JSON.parse(text) as ServerResponse;
            } catch {
              finish(() => reject(new MainInstanceError("frame", "主实例响应不是合法 JSON 帧")));
              return;
            }
            if (frame.type !== "server-response" || frame.rpcId !== rpcId) {
              finish(() => reject(new MainInstanceError("frame", "主实例响应帧不匹配（rpcId 回显不符）")));
              return;
            }
            if (!frame.result.ok) {
              const error = frame.result.error;
              finish(() => reject(new MainInstanceError(error.code, error.message)));
              return;
            }
            const value = frame.result.value;
            finish(() => resolve(value));
          });
        }
      );
      const abort = (): void => {
        req.destroy(new Error("request aborted"));
      };
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
      req.on("error", (error: Error) => {
        finish(() => reject(new MainInstanceError(
          signal?.aborted === true ? "aborted" : "transport",
          signal?.aborted === true ? "已取消目录选择" : `无法连接主实例 ${this.baseUrl}：${error.message}`
        )));
      });
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      req.write(body);
      req.end();
    });
  }

  /** Plain loopback JSON endpoint owned by the 3080 Obsidian target-context Host plugin. */
  private postJson(path: string, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    const body = JSON.stringify(payload);
    return new Promise<unknown>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port === "" ? undefined : Number(url.port),
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let value: {
              ok?: boolean;
              value?: unknown;
              error?: { code?: string; message?: string };
            };
            try {
              value = JSON.parse(text) as typeof value;
            } catch {
              reject(new MainInstanceError("target-frame", "目标上下文响应不是合法 JSON"));
              return;
            }
            if (res.statusCode !== 200 || value.ok !== true) {
              reject(new MainInstanceError(
                value.error?.code ?? "target-transport",
                value.error?.message ?? `目标上下文端点返回 HTTP ${res.statusCode ?? 0}`
              ));
              return;
            }
            resolve(value.value);
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      req.on("error", (error: Error) => {
        reject(new MainInstanceError("target-transport", `无法提交 Obsidian 目标上下文：${error.message}`));
      });
      req.write(body);
      req.end();
    });
  }

  /** Read-only liveness probe: session.list answers. */
  async ping(): Promise<boolean> {
    try {
      await this.call("session.list", {}, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const value = (await this.call("session.list", {})) as { items: SessionSummary[] };
    return value.items;
  }

  async history(sessionId: string): Promise<HistoryPage> {
    return (await this.call("session.history", { sessionId })) as HistoryPage;
  }

  /** Create a new session on the main instance (cwd or workspaceId binds it). */
  async createSession(cwd?: string, workspaceId?: string): Promise<{ sessionId: string }> {
    const payload = workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {};
    return (await this.call("session.create", payload)) as { sessionId: string };
  }

  /** Durable official title projection; used once when a content Session is created. */
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.call("session.rename", { sessionId, title });
  }

  /** Bind one Session to exactly one Obsidian target on the main Host. */
  async bindObsidianTarget(binding: ObsidianTargetBinding): Promise<void> {
    await this.postJson("/api/obsidian-target", binding);
  }

  /** Workspace rows (path-scoped workspaces on the main instance). */
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const value = (await this.call("workspace.list", {})) as {
      items: WorkspaceSummary[];
    };
    return value.items;
  }

  /** Register one exact directory as a durable DSH file workspace. */
  async createWorkspace(path: string): Promise<{ workspace: WorkspaceSummary; created: boolean }> {
    return (await this.call("workspace.create", { path })) as {
      workspace: WorkspaceSummary;
      created: boolean;
    };
  }

  /** Native directory picker exposed by the official DSH Host. */
  async pickDirectory(signal: AbortSignal): Promise<string | null> {
    const value = (await this.call("host.pickDirectory", {}, 300_000, signal)) as { path: string | null };
    return value.path;
  }

  /** Attach or move an existing Session into the selected file workspace. */
  async moveSessionToWorkspace(workspaceId: string, sessionId: string): Promise<WorkspaceSummary> {
    const value = (await this.call("workspace.insertSessionBefore", {
      workspaceId,
      sessionId
    })) as { workspace: WorkspaceSummary };
    return value.workspace;
  }

  /** Preserve an explicitly selected preset while replacing a blank legacy Session. */
  async selectAgentPreset(sessionId: string, agentPreset: string): Promise<void> {
    await this.call("agentPreset.select", { sessionId, agentPreset });
  }

  /** Queue a user prompt into the session (mode: queue — never steals the turn). */
  async prompt(sessionId: string, text: string): Promise<void> {
    await this.call("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }]
    });
  }

  async listModels(sessionId: string): Promise<ModelsCatalog> {
    return (await this.call("session.models", { sessionId })) as ModelsCatalog;
  }

  async selectModel(sessionId: string, provider: string, model: string): Promise<void> {
    await this.call("session.selectModel", { sessionId, provider, model });
  }

  /** Run a slash command on the session via the commands/execute channel. */
  async runCommand(sessionId: string, line: string): Promise<string> {
    const value = (await this.call("commands/execute", {
      args: { agentId: sessionId, line }
    })) as CommandResult;
    return value.result?.text ?? `命令已执行（${value.result?.kind ?? "unknown"}）`;
  }
}
