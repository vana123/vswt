import * as vscode from 'vscode';
import type {
  AppState,
  FromWebview,
  Notification,
  RpcRequest,
  RpcResponse
} from './protocol';

export type RequestHandler = (req: RpcRequest) => Promise<unknown>;
export type StateProducer = () => Promise<AppState>;

export class SidebarHost implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vswt.sidebar';
  private view: vscode.WebviewView | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handler: RequestHandler,
    private readonly produceState: StateProducer
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'media')
      ]
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) => void this.handleRequest(msg));
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  setBadge(count: number): void {
    if (!this.view) return;
    if (count > 0) {
      this.view.badge = { value: count, tooltip: `${count} active session${count === 1 ? '' : 's'}` };
    } else {
      this.view.badge = undefined;
    }
  }

  async pushState(): Promise<void> {
    if (!this.view) return;
    const state = await this.produceState();
    const notif: Notification = { kind: 'state', ...state };
    void this.view.webview.postMessage(notif);
  }

  private async handleRequest(msg: FromWebview): Promise<void> {
    if (!this.view) return;
    const { rid, ...req } = msg;
    let response: RpcResponse;
    try {
      const data = await this.handler(req as RpcRequest);
      response = data === undefined
        ? { rid, ok: true }
        : { rid, ok: true, data };
    } catch (err) {
      response = { rid, ok: false, error: (err as Error).message };
    }
    void this.view.webview.postMessage(response);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
    );
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}'; font-src ${webview.cspSource} https://fonts.gstatic.com;" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>vsWT</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
