import * as vscode from 'vscode';
import { ProfileStorage } from '../services/profileStorage';
import { FolderSyncService } from '../services/folderSyncService';
import { WebviewIncomingMessage, WebviewOutgoingMessage } from '../types';

export class ProfilesWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'folderProfilesView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: vscode.Uri,
    private readonly storage: ProfileStorage,
    private readonly syncService: FolderSyncService
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewIncomingMessage) => {
      switch (message.command) {
        case 'ready':
        case 'refresh':
          await this.postProfilesUpdate();
          break;

        case 'toggleProfile':
          await this.syncService.toggleProfile(message.profileName, message.enabled);
          await this.postProfilesUpdate();
          break;

        case 'deleteProfile':
          await this.syncService.deleteProfile(message.profileName);
          await this.postProfilesUpdate();
          break;

        case 'openFolder':
          this.revealFolderInWorkspace(message.folderPath);
          break;

        case 'openManifest':
          this.openManifestFile(message.manifestPath);
          break;

        case 'toggleAutoSync':
          await this.storage.patchProfile(message.profileName, { autoSync: message.enabled });
          await this.postProfilesUpdate();
          break;

        case 'openConfigFile':
          vscode.commands.executeCommand('folderProfiles.openConfigFile');
          break;
      }
    });

    this.postProfilesUpdate();
  }

  /**
   * Posts the current profile list to the Webview.
   */
  public async postProfilesUpdate(): Promise<void> {
    if (!this._view) {
      return;
    }
    const config = await this.storage.loadConfig();
    const msg: WebviewOutgoingMessage = {
      type: 'setProfiles',
      profiles: config.profiles
    };
    this._view.webview.postMessage(msg);
  }

  private async revealFolderInWorkspace(relPath: string): Promise<void> {
    const targetUri = vscode.Uri.joinPath(this.workspaceRoot, relPath);
    try {
      await vscode.commands.executeCommand('revealInExplorer', targetUri);
    } catch {
      vscode.window.showInformationMessage(`Target folder: ${relPath}`);
    }
  }

  private async openManifestFile(relPath: string): Promise<void> {
    const targetUri = vscode.Uri.joinPath(this.workspaceRoot, relPath);
    try {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      await vscode.window.showTextDocument(doc);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Unable to open manifest file: ${err.message || err}`);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource};
    img-src ${webview.cspSource} https:;
  ">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Folder Profiles</title>
</head>
<body>
  <div class="view-container">
    <header class="app-header">
      <div class="header-titles">
        <span class="header-main-title">Workspace Profiles</span>
        <span id="profiles-counter" class="profiles-counter">0 profiles</span>
      </div>
      <button id="btn-open-config" class="btn-icon-action" title="Open the profiles YAML file">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.75 1A1.75 1.75 0 0 0 2 2.75v10.5C2 14.216 2.784 15 3.75 15h8.5A1.75 1.75 0 0 0 14 13.25V5.414a1.75 1.75 0 0 0-.513-1.237l-2.664-2.664A1.75 1.75 0 0 0 9.586 1H3.75zM3.5 2.75a.25.25 0 0 1 .25-.25H9v2.75c0 .966.784 1.75 1.75 1.75h2.75v6.25a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25V2.75zm7 .31 1.94 1.94H10.75a.25.25 0 0 1-.25-.25V3.06zM5 8.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 8.25zm0 2.5a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75z"/>
        </svg>
      </button>
    </header>

    <p class="create-hint">
      To create a profile, select folders and/or files in the Explorer, then right-click and choose
      <strong>Folder Profiles: Create / Update Profile...</strong>
    </p>

    <main id="profiles-list" class="cards-list">
      <!-- Rendered dynamically by media/main.js -->
    </main>

    <!-- Floating popover for excess folders (> 5 folders) -->
    <div id="folders-popover" class="floating-popover hidden" role="tooltip" aria-hidden="true">
      <div class="popover-arrow"></div>
      <div class="popover-header">
        <span class="popover-title">All Profile Items</span>
        <button id="popover-close" class="popover-close-btn" title="Close">&times;</button>
      </div>
      <div id="popover-content" class="popover-body"></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}