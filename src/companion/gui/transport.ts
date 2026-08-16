/**
 * Obsidian transport for the official DSH client API — replaces the browser
 * WebApiClient (whose doFetch/resolveBase assume the web page origin and
 * CSP) with Node sockets, mirroring the plugin's existing DshClient choice.
 *
 * The AbstractApiClient base class is NOT imported statically: the official
 * client entries ship as self-registering bundles (window.__ModuleLoader__)
 * that only exist at runtime. gui-boot loads them via vm and hands the base
 * class constructor to makeObsidianApiClient.
 *
 * Everything protocol-shaped (callUnary framing, session.* methods) lives in
 * the base class — this file only swaps the physical transport:
 *   - doFetch       → node:http request (CSP-exempt)
 *   - resolveBase   → the main instance URL (3080)
 *   - openMux/host  → `ws` downlinks (/api/events.mux, /api/events.host)
 */

import { request as httpRequest } from "node:http";
import type { AbstractApiClient, ConnectionConfig } from "@deepseek-ai/dsh-client-connection/client";
import WebSocket from "ws";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Boot log bridge (installed by mountGui; no-op when absent). */
function guiLog(message: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__DSH_GUI_LOG__?.(message);
  } catch {
    // ignore
  }
}

/** Minimal fetch-compatible Response for the node transport. */
class NodeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(
    private readonly bodyText: string,
    status: number,
    headers: Record<string, string> = {}
  ) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = headers;
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }
  async text(): Promise<string> {
    return this.bodyText;
  }
}

/** node:http POST/GET stand-in for globalThis.fetch (CSP-exempt). */
export function nodeFetchCompat(
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
): Promise<NodeResponse> {
  const url = typeof input === "string" ? new URL(input) : input;
  return new Promise<NodeResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        headers: {
          ...(init?.headers ?? {}),
          ...(init?.body !== undefined ? { "content-length": Buffer.byteLength(init.body) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(new NodeResponse(text, res.statusCode ?? 500));
        });
      }
    );
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => req.destroy(new Error("nodeFetchCompat: timeout")));
    req.on("error", reject);
    if (init?.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** Constructor shape of the runtime-loaded AbstractApiClient. */
export interface ApiClientCtor {
  new (timeoutMs?: number): AbstractApiClient;
}

/** Envelope yielded by the ws downlink generators. */
export interface WsEnvelope {
  rpcId?: string;
  payload: unknown;
}

/** Loose sink set (official ConnectionSinks is typed to official frames). */
export interface ObsidianSinks {
  onMuxEnvelope?: (envelope: unknown) => void;
  onHostEnvelope?: (envelope: unknown) => void;
  onConnected?: (description: unknown) => void;
  onStateChange?: (state: string) => void;
}

/**
 * Build an AbstractApiClient subclass bound to the main instance base URL.
 * @param Base - the runtime-loaded official base class.
 * @param baseUrl - e.g. http://127.0.0.1:3080.
 */
export function makeObsidianApiClient(Base: ApiClientCtor, baseUrl: string): ApiClientCtor {
  return class ObsidianApiClient extends Base {
    constructor() {
      super();
    }

    protected resolveBase(): string {
      return baseUrl;
    }

    protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
      const headers: Record<string, string> = {};
      if (init?.headers !== undefined) {
        const source = init.headers;
        if (source instanceof Headers) {
          source.forEach((value, key) => {
            headers[key] = value;
          });
        } else if (Array.isArray(source)) {
          for (const [key, value] of source) headers[key] = value;
        } else {
          Object.assign(headers, source);
        }
      }
      const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return nodeFetchCompat(input, {
        ...(init?.method === undefined ? {} : { method: init.method }),
        headers,
        ...(init?.body === undefined ? {} : { body: String(init.body) }),
        ...(signal === undefined ? {} : { signal })
      }) as unknown as Promise<Response>;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected openMux(_payload: unknown, signal: AbortSignal, onOpen?: () => void): any {
      return this.readWsStream("/api/events.mux", signal, onOpen);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected openHost(_payload: unknown, signal: AbortSignal, onOpen?: () => void): any {
      return this.readWsStream("/api/events.host", signal, onOpen);
    }

    /**
     * WebSocket downlink with the same inbox/wake contract as the official
     * browser readWebSocket. Frames are parsed loosely (server-request
     * envelope; the payload is passed through untouched — the consumers run
     * their own schema validation).
     */
    private async *readWsStream(path: string, signal: AbortSignal, onOpen?: () => void): AsyncGenerator<WsEnvelope> {
      const url = new URL(path, this.resolveBase());
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url.toString());
      const inbox: Array<{ kind: "frame"; envelope: WsEnvelope } | { kind: "end" }> = [];
      let wake: (() => void) | undefined;
      const enqueue = (item: { kind: "frame"; envelope: WsEnvelope } | { kind: "end" }): void => {
        inbox.push(item);
        wake?.();
        wake = undefined;
      };
      const handleOpen = (): void => {
        guiLog(`ws open: ${path}`);
        onOpen?.();
      };
      socket.on("error", (error) => {
        guiLog(`ws error: ${path}: ${String(error)}`);
      });
      const handleMessage = (data: Buffer | string): void => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.error(`[obsidian-transport] dropping non-JSON frame on ${path}`);
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const record = parsed as Record<string, unknown>;
        if (record.type !== "server-request") return;
        enqueue({
          kind: "frame",
          envelope: typeof record.rpcId === "string"
            ? { rpcId: record.rpcId, payload: record.payload }
            : { payload: record.payload }
        });
      };
      const handleClose = (): void => {
        enqueue({ kind: "end" });
      };
      const handleAbort = (): void => {
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      };

      socket.on("open", handleOpen);
      socket.on("message", handleMessage);
      socket.on("close", handleClose);
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) handleAbort();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          while (inbox.length > 0) {
            const item = inbox.shift();
            if (item?.kind === "end") return;
            if (item !== undefined) yield item.envelope;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        signal.removeEventListener("abort", handleAbort);
        socket.off("open", handleOpen);
        socket.off("message", handleMessage);
        socket.off("close", handleClose);
        handleAbort();
      }
    }
  };
}

/**
 * Port of the official ConnectionController loop (reconnect + dual streams)
 * over the ObsidianApiClient.
 */
export class ObsidianConnectionController {
  private generation = 0;
  private attempt = 0;
  private current: AbortController | null = null;
  private running = false;
  private lastState: string | null = null;

  constructor(
    private readonly api: AbstractApiClient,
    private readonly sinks: ObsidianSinks,
    private readonly config: ConnectionConfig = {}
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.current?.abort();
    this.current = null;
  }

  private backoffDelay(attempt: number): number {
    const base = this.config.backoffBaseMs ?? 1_000;
    const factor = this.config.backoffFactor ?? 2;
    const max = this.config.backoffMaxMs ?? 15_000;
    const cap = Math.min(max, base * factor ** Math.max(0, attempt - 1));
    return cap / 2 + Math.random() * (cap / 2);
  }

  private emitState(state: string): void {
    if (this.lastState === state) return;
    this.lastState = state;
    try {
      this.sinks.onStateChange?.(state);
    } catch (error) {
      console.error("[gui-boot] connection state sink threw:", error);
    }
  }

  private callSink(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error("[gui-boot] connection sink threw:", error);
    }
  }

  private async pumpStream(stream: AsyncIterable<WsEnvelope>, sink: ((envelope: unknown) => void) | undefined, onEnd: () => void): Promise<void> {
    try {
      for await (const envelope of stream) {
        const payload = (envelope as { payload?: { type?: string } }).payload;
        if (payload?.type === "stream/error") break;
        if (sink !== undefined) {
          this.callSink(() => sink(envelope));
        }
      }
    } catch {
      // stream teardown is normal on reconnect
    }
    onEnd();
  }

  private async loop(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (this.running) {
      const gen = ++this.generation;
      const ac = new AbortController();
      this.current = ac;
      let muxOpened = (): void => {};
      let hostOpened = (): void => {};
      const streamsOpen = Promise.all([
        new Promise<void>((resolve) => { muxOpened = resolve; }),
        new Promise<void>((resolve) => { hostOpened = resolve; })
      ]);
      guiLog("opening mux/host streams");
      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort();
          resolve();
        };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          void this.pumpStream((this.api as any).events.mux({}, ac.signal, muxOpened), this.sinks.onMuxEnvelope, settle);
        } catch (error) {
          guiLog(`events.mux threw: ${error instanceof Error ? error.message : String(error)}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void this.pumpStream((this.api as any).events.host({}, ac.signal, hostOpened), this.sinks.onHostEnvelope, settle);
      });
      try {
        const timeout = new AbortController();
        const timeoutMs = this.config.streamOpenTimeoutMs ?? 15_000;
        const streamOpen = Promise.race([
          streamsOpen,
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              timeout.abort();
              resolve();
            }, timeoutMs);
            void timer;
          })
        ]);
        const [description] = await Promise.all([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this.api as any).host.describe({}),
          streamOpen
        ]);
        timeout.abort();
        const descriptionResult = description?.result as { ok: boolean; error?: { code: string; message: string }; value?: unknown } | undefined;
        if (descriptionResult === undefined || !descriptionResult.ok) {
          throw new Error(`host.describe failed: ${descriptionResult?.error?.code ?? "unknown"}: ${descriptionResult?.error?.message ?? ""}`);
        }
        if (ac.signal.aborted) throw new Error("generation aborted during readiness handshake");
        this.attempt = 0;
        this.emitState("connected");
        if (this.running && !ac.signal.aborted) {
          this.callSink(() => this.sinks.onConnected?.(descriptionResult.value));
        }
      } catch (error) {
        guiLog(`connection loop handshake error: ${error instanceof Error ? error.message : String(error)}`);
        if (!ac.signal.aborted) ac.abort();
      }
      await failed;
      guiLog("connection loop iteration ended");
      if (!this.running) return;
      this.emitState("reconnecting");
      this.attempt += 1;
      console.warn(`[gui-boot] connection lost, retry #${this.attempt}`);
      await new Promise<void>((resolve) => {
        const delay = this.backoffDelay(this.attempt);
        const timer = setTimeout(() => {
          resolve();
        }, delay);
        void timer;
      });
    }
  }
}

/** Loose connection-handle shape (the official types are overly precise for
 * our Node transport; the consuming plugins only use these members). */
export interface ObsidianConnectionHandle {
  api: unknown;
  isLoopback: boolean;
  hostDescription: { getSnapshot(): unknown; subscribe(listener: () => void): () => void };
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> };
  start(sinks: ObsidianSinks, config?: ConnectionConfig): { stop(): void };
}

/** Provide the official connection contract over our Node transport. */
export function buildConnectionHandle(apiCtor: ApiClientCtor, baseUrl: string): ObsidianConnectionHandle {
  const api = new apiCtor();
  let started = false;
  let description: unknown;
  const descriptionListeners = new Set<() => void>();
  const publishDescription = (next: unknown): void => {
    if (Object.is(description, next)) return;
    description = next;
    for (const listener of [...descriptionListeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[gui-boot] description listener threw:", error);
      }
    }
  };
  const handle: ObsidianConnectionHandle = {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener: () => void) => {
        descriptionListeners.add(listener);
        return () => {
          descriptionListeners.delete(listener);
        };
      }
    },
    rpc: createObsidianRpc(baseUrl),
    start(sinks: ObsidianSinks, config?: ConnectionConfig) {
      guiLog("handle.start invoked");
      if (started) throw new Error("connection: the stream loop is already owned by another consumer");
      started = true;
      const controller = new ObsidianConnectionController(
        api,
        {
          ...sinks,
          onConnected: (next) => {
            publishDescription(next);
            if (!Object.is(description, next)) return;
            sinks.onConnected?.(next);
          },
          onStateChange: (state) => {
            if (state === "reconnecting") publishDescription(undefined);
            sinks.onStateChange?.(state);
          }
        },
        config ?? {}
      );
      controller.start();
      return {
        stop: () => {
          controller.stop();
          publishDescription(undefined);
        }
      };
    }
  };
  return handle;
}

/** Generic RPC caller over the same channel/endpoint wire as the web page. */
function createObsidianRpc(baseUrl: string): ObsidianConnectionHandle["rpc"] {
  return {
    async call(channel, endpoint, payload, signal) {
      const rpcId = crypto.randomUUID();
      const message = { type: "client-request", rpcId, method: endpoint, payload };
      const response = await nodeFetchCompat(new URL(`${channel}/${endpoint}`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        ...(signal === undefined ? {} : { signal })
      });
      if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
      const full = (await response.json()) as { rpcId: string; result: unknown };
      if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}`);
      return full.result;
    }
  };
}
