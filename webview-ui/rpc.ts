import type { RpcRequest, ToWebview, Notification } from '../src/webview/protocol';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const notifListeners = new Set<(n: Notification) => void>();

window.addEventListener('message', e => {
  const msg = e.data as ToWebview;
  if ('rid' in msg) {
    const p = pending.get(msg.rid);
    if (p) {
      pending.delete(msg.rid);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? 'unknown error'));
    }
  } else {
    for (const l of notifListeners) l(msg);
  }
});

let counter = 0;

export function send(req: RpcRequest): Promise<unknown> {
  const rid = `r${++counter}`;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    vscode.postMessage({ ...req, rid });
  });
}

export function onNotification(handler: (n: Notification) => void): () => void {
  notifListeners.add(handler);
  return () => {
    notifListeners.delete(handler);
  };
}
