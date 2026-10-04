// JSON-RPC 2.0 over a runtime.Port (SPEC §4.1).

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class Rpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private port: browser.runtime.Port;
  onNotification: (method: string, params: any) => void = () => {};
  /** Answers requests from the other side. Throw an RpcError to choose the error code. */
  onRequest: (method: string, params: any) => Promise<unknown> = async (method) => {
    throw new RpcError(-32601, `unknown method \`${method}\``);
  };
  onClose: (error: string | undefined) => void = () => {};

  constructor(port: browser.runtime.Port) {
    this.port = port;
    port.onMessage.addListener((msg: any) => {
      if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
        else p.resolve(msg.result);
      } else if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
        this.onRequest(msg.method, msg.params).then(
          (result) => this.port.postMessage({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
          (e) =>
            this.port.postMessage({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: e instanceof RpcError ? e.code : -32000, message: e instanceof Error ? e.message : String(e) },
            }),
        );
      } else if (typeof msg.method === "string") {
        this.onNotification(msg.method, msg.params);
      }
    });
    port.onDisconnect.addListener((p) => {
      const error = p.error?.message;
      for (const w of this.pending.values()) w.reject(new Error(error ?? "disconnected"));
      this.pending.clear();
      this.onClose(error);
    });
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ jsonrpc: "2.0", id, method, params: params ?? null });
    });
  }

  close() {
    this.port.disconnect();
  }
}
