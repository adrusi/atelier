// Minimal WebDriver BiDi client, shared by dev/atelier-dev.ts and spikes.
//
// Firefox allows only one BiDi session at a time, so prefer withSession() for
// short interactions and end sessions promptly.

export class Bidi {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const waiter = msg.id !== undefined && this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.type === "error") waiter.reject(new Error(`${msg.error}: ${msg.message}`));
      else waiter.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      for (const w of this.pending.values()) w.reject(new Error("BiDi connection closed"));
      this.pending.clear();
    });
  }

  static connect(port: number): Promise<Bidi> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
      ws.addEventListener("open", () => resolve(new Bidi(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`can't connect to BiDi on port ${port}`)), { once: true });
    });
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

/** Opens a connection and a session, runs f, then ends the session and closes the connection. */
export async function withSession<T>(port: number, f: (bidi: Bidi) => Promise<T>): Promise<T> {
  const bidi = await Bidi.connect(port);
  try {
    await bidi.send("session.new", { capabilities: {} });
    try {
      return await f(bidi);
    } finally {
      await bidi.send("session.end").catch(() => {});
    }
  } finally {
    bidi.close();
  }
}

export async function reachable(port: number): Promise<boolean> {
  try {
    (await Bidi.connect(port)).close();
    return true;
  } catch {
    return false;
  }
}

/** Converts a BiDi RemoteValue to plain JSON, as far as that's meaningful. */
export function fromRemoteValue(v: any): unknown {
  switch (v.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return v.value;
    case "array":
    case "set":
      return v.value?.map(fromRemoteValue) ?? `[${v.type}]`;
    case "object":
    case "map":
      return v.value
        ? Object.fromEntries(
            v.value.map(([k, val]: [any, any]) => [typeof k === "string" ? k : JSON.stringify(fromRemoteValue(k)), fromRemoteValue(val)]),
          )
        : `[${v.type}]`;
    default:
      return `[${v.type}]`;
  }
}

/** Evaluates expression in a browsing context's page realm and returns the result as plain JSON. */
export async function evaluate(bidi: Bidi, context: string, expression: string): Promise<unknown> {
  const r = await bidi.send("script.evaluate", {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (r.type === "exception") throw new Error(`page exception: ${r.exceptionDetails.text}`);
  return fromRemoteValue(r.result);
}
