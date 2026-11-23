// WebSocket client to the bridge (D4, D5, D11). Chrome-free: everything injected.
//  - hello {protocolVersion, extensionVersion, secret?, pairCode?}
//  - ping every 20s once welcomed
//  - reconnect: short backoff, plus a chrome.alarms tick every 30s (the worker can be evicted)

export type Status = "unpaired" | "connecting" | "connected" | "disconnected" | "pair-failed" | "version-mismatch";

export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface BridgeClientDeps {
  makeSocket(url: string): WsLike;
  loadConfig(): Promise<{ port: number; secret: string | null }>;
  saveSecret(secret: string | null): Promise<void>;
  onMessage(msg: any): void;
  onStatus?(status: Status, error: string): void;
  protocolVersion: number;
  extensionVersion: string;
  extensionId: string;
  features?: string[];
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const PING_MS = 20_000;
export const ALARM_MINUTES = 0.5;
const OPEN = 1;
const CONNECTING = 0;

export function createBridgeClient(d: BridgeClientDeps) {
  let ws: WsLike | null = null;
  let status: Status = "disconnected";
  let lastError = "";
  let pairCode: string | null = null;
  let heartbeat: unknown = null;
  let reconnectTimer: unknown = null;
  let backoff = 500;
  let welcomed = false;

  function setStatus(s: Status, err = "") {
    status = s;
    lastError = err;
    d.onStatus?.(s, err);
  }

  function send(msg: unknown): boolean {
    if (ws && ws.readyState === OPEN && welcomed) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function stopHeartbeat() {
    if (heartbeat != null) d.clearInterval(heartbeat);
    heartbeat = null;
  }

  async function connect() {
    if (ws && (ws.readyState === OPEN || ws.readyState === CONNECTING)) return;
    const cfg = await d.loadConfig();
    if (!cfg.secret && !pairCode) {
      setStatus("unpaired");
      return;
    }
    setStatus("connecting");
    let sock: WsLike;
    try {
      sock = d.makeSocket(`ws://127.0.0.1:${cfg.port}/ext`);
    } catch (e) {
      setStatus("disconnected", String((e as Error)?.message ?? e));
      scheduleReconnect();
      return;
    }
    ws = sock;
    welcomed = false;
    sock.onopen = () => {
      const hello = {
        type: "hello",
        protocolVersion: d.protocolVersion,
        extensionVersion: d.extensionVersion,
        // spike field names, still read by older bridges
        version: d.extensionVersion,
        extensionId: d.extensionId,
        ...(d.features?.length ? { features: d.features } : {}),
        ...(cfg.secret ? { secret: cfg.secret } : {}),
        ...(pairCode ? { pairCode } : {}),
      };
      sock.send(JSON.stringify(hello));
    };
    sock.onmessage = (ev) => onRaw(String(ev.data));
    sock.onclose = (ev) => {
      if (ws === sock) ws = null;
      welcomed = false;
      stopHeartbeat();
      if (status !== "pair-failed" && status !== "unpaired" && status !== "version-mismatch") setStatus("disconnected", ev?.reason || "");
      scheduleReconnect();
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer != null) return;
    if (status === "pair-failed" || status === "unpaired" || status === "version-mismatch") return;
    reconnectTimer = d.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  }

  async function onRaw(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.type) {
      case "welcome":
        backoff = 500;
        welcomed = true;
        if (msg.secret) {
          await d.saveSecret(msg.secret);
          pairCode = null;
        }
        setStatus("connected");
        stopHeartbeat();
        heartbeat = d.setInterval(() => {
          if (ws && ws.readyState === OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
        return;
      case "error": {
        const code = msg.error?.code;
        if (code === "UNAUTHORIZED") {
          pairCode = null;
          const cfg = await d.loadConfig();
          if (cfg.secret && /secret/i.test(String(msg.error.message))) await d.saveSecret(null);
          setStatus("pair-failed", String(msg.error.message ?? ""));
          ws?.close();
          return;
        }
        if (code === "VERSION_MISMATCH") {
          setStatus("version-mismatch", [msg.error.message, msg.error.hint].filter(Boolean).join(" "));
          ws?.close();
          return;
        }
        d.onMessage(msg);
        return;
      }
      case "pong":
        return;
      default:
        d.onMessage(msg);
    }
  }

  return {
    connect,
    send,
    /** chrome.alarms tick (every 30s): reconnect if no socket is open. */
    tick() {
      if (!ws || ws.readyState > OPEN) {
        if (status === "version-mismatch") return;
        void connect();
      }
    },
    pair(code: string) {
      pairCode = code.trim().toUpperCase();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      backoff = 500;
      if (reconnectTimer != null) d.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      setStatus("connecting");
      return connect();
    },
    reconnect() {
      backoff = 500;
      if (status === "pair-failed" || status === "version-mismatch") setStatus("disconnected");
      return connect();
    },
    disconnect(next: Status = "unpaired") {
      setStatus(next);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
    status: () => status,
    lastError: () => lastError,
    connected: () => status === "connected",
  };
}
