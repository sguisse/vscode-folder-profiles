import * as vscode from 'vscode';
import * as path from 'path';
import { ProfileStorage } from './services/profileStorage';
import { ManifestService } from './services/manifestService';
import { FolderSyncService } from './services/folderSyncService';
import { ProfilesWebviewViewProvider } from './views/profilesWebviewView';
import { FolderProfile } from './types';
import { getManifestsFolderPath, getProfilesFilePath } from './settings';

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    const commands = [
      'folderProfiles.createFromSelection',
      'folderProfiles.refresh',
      'folderProfiles.openConfigFile',
      'folderProfiles.toggleProfile',
      'folderProfiles.deleteProfile'
    ];
    for (const command of commands) {
      context.subscriptions.push(
        vscode.commands.registerCommand(command, () => {
        vscode.window.showWarningMessage(
            'Open a folder or workspace before using Folder Profiles.'
          );
        })
      );
    }
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri;

  // Initialize core services
  const profileStorage = new ProfileStorage(workspaceRoot);
  const manifestService = new ManifestService(workspaceRoot);
  const folderSyncService = new FolderSyncService(workspaceRoot, profileStorage, manifestService);

  // Initialize sidebar Webview provider
  const webviewProvider = new ProfilesWebviewViewProvider(
    context.extensionUri,
    workspaceRoot,
    profileStorage,
    folderSyncService
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ProfilesWebviewViewProvider.viewType,
      webviewProvider
    )
  );

  /**
   * Command: Create or update a profile from selected folders and/or files in the Explorer
   */
  const createFromSelectionCommand = vscode.commands.registerCommand(
    'folderProfiles.createFromSelection',
    async (primaryUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      try {
        const candidateUris = (allSelectedUris && allSelectedUris.length > 0)
          ? allSelectedUris
          : (primaryUri ? [primaryUri] : []);

        const validFolderPaths: string[] = [];

        for (const uri of candidateUris) {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type & (vscode.FileType.Directory | vscode.FileType.File)) {
              const rel = path
                .relative(workspaceRoot.fsPath, uri.fsPath)
                .replace(/\\/g, '/');
              if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !validFolderPaths.includes(rel)) {
                validFolderPaths.push(rel);
              }
            }
          } catch {
            // Ignore unresolved paths
          }
        }

        if (validFolderPaths.length === 0) {
          vscode.window.showWarningMessage(
            'Please select at least one folder or file in the Explorer to create or update a profile.'
          );
          return;
        }

        // Load existing configuration
        const currentConfig = await profileStorage.loadConfig();
        const existingProfiles = currentConfig.profiles;

        // Step 1: Prompt user for new profile vs update existing
        const quickPickItems: vscode.QuickPickItem[] = [
          {
            label: '$(plus) Create a new profile',
            description: 'Save a new profile entry',
            alwaysShow: true
          },
          ...existingProfiles.map(p => ({
            label: `$(folder) ${p.name}`,
            description: p.description || '',
            detail: `${p.folders.length} item(s): ${p.folders.slice(0, 3).join(', ')}${p.folders.length > 3 ? '...' : ''}`
          }))
        ];

        const selection = await vscode.window.showQuickPick(quickPickItems, {
          placeHolder: 'Select an existing profile to update or create a new one',
          ignoreFocusOut: true
        });

        if (!selection) {
          return;
        }

        const isNew = selection.label.startsWith('$(plus)');
        let targetProfileName = '';
        let initialDescription = '';
        let initialTags: string[] = [];

        if (isNew) {
          const inputName = await vscode.window.showInputBox({
            prompt: 'Unique profile name (e.g. bmad-core-tools)',
            placeHolder: 'profile-name',
            ignoreFocusOut: true,
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'Profile name is required.';
              }
              if (!/^[a-zA-Z0-9_\-\.]+$/.test(value.trim())) {
                return 'Name must only contain alphanumeric characters, hyphens, underscores, and dots.';
              }
              return null;
            }
          });

          if (!inputName) {
            return;
          }
          targetProfileName = inputName.trim();
        } else {
          targetProfileName = selection.label.replace('$(folder) ', '').trim();
          const existing = existingProfiles.find(p => p.name === targetProfileName);
          if (existing) {
            initialDescription = existing.description || '';
            initialTags = existing.tags || [];
          }
        }

        // Step 2: Description input
        const inputDesc = await vscode.window.showInputBox({
          prompt: 'Profile description (optional)',
          value: initialDescription,
          ignoreFocusOut: true
        });

        // Step 3: Tags input
        const inputTags = await vscode.window.showInputBox({
          prompt: 'Comma-separated tags (e.g. bmad, tooling, audit)',
          value: initialTags.join(', '),
          ignoreFocusOut: true
        });

        const parsedTags = inputTags
          ? inputTags
              .split(',')
              .map(t => t.trim())
              .filter(t => t.length > 0)
          : [];

        // Step 4: Generate XML manifest and update YAML config
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Saving profile "${targetProfileName}"...`,
            cancellable: false
          },
          async (progress) => {
            progress.report({ message: 'Generating XML manifest...' });
            const manifestRelativePath = `${getManifestsFolderPath()}/${targetProfileName}.manifest.xml`;

            const { md5 } = await manifestService.generateManifest(validFolderPaths, manifestRelativePath);

            progress.report({ message: `Updating ${getProfilesFilePath()}...` });
            const previous = existingProfiles.find(p => p.name === targetProfileName);
            const profileEntry: FolderProfile = {
              name: targetProfileName,
              description: inputDesc?.trim() || undefined,
              tags: parsedTags,
              enabled: true,
              autoSync: previous?.autoSync ?? false,
              folders: validFolderPaths,
              manifestPath: manifestRelativePath,
              manifestMD5: md5
            };

            await profileStorage.upsertProfile(profileEntry);
            await webviewProvider.postProfilesUpdate();

            vscode.window.showInformationMessage(
              `Profile "${targetProfileName}" saved successfully (${validFolderPaths.length} item(s)).`
            );
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Error saving folder profile: ${err.message || err}`
        );
      }
    }
  );

  /**
   * Command: Refresh the Webview
   */
  const refreshCommand = vscode.commands.registerCommand('folderProfiles.refresh', async () => {
    await webviewProvider.postProfilesUpdate();
  });

  /**
   * Command: Open the profiles YAML file in the editor
   */
  const openConfigFileCommand = vscode.commands.registerCommand(
    'folderProfiles.openConfigFile',
    async () => {
      const configUri = profileStorage.configFileUri;
      try {
        await vscode.workspace.fs.stat(configUri);
      } catch {
        vscode.window.showInformationMessage(
          `${getProfilesFilePath()} does not exist yet. Create a profile first.`
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(configUri);
      await vscode.window.showTextDocument(doc);
    }
  );

  /**
   * Command: Toggle profile state
   */
  const toggleProfileCommand = vscode.commands.registerCommand(
    'folderProfiles.toggleProfile',
    async (profileName: string, enabled?: boolean) => {
      await folderSyncService.toggleProfile(profileName, enabled);
      await webviewProvider.postProfilesUpdate();
    }
  );

  /**
   * Command: Delete profile
   */
  const deleteProfileCommand = vscode.commands.registerCommand(
    'folderProfiles.deleteProfile',
    async (profileName: string) => {
      await folderSyncService.deleteProfile(profileName);
      await webviewProvider.postProfilesUpdate();
    }
  );

  // Watch external changes to the profiles YAML file (path is configurable)
  let yamlWatcher = createYamlWatcher();

  function createYamlWatcher(): vscode.FileSystemWatcher {
    const configUri = profileStorage.configFileUri;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(configUri.fsPath)), path.basename(configUri.fsPath))
    );
    watcher.onDidChange(() => webviewProvider.postProfilesUpdate());
    watcher.onDidCreate(() => webviewProvider.postProfilesUpdate());
    watcher.onDidDelete(() => webviewProvider.postProfilesUpdate());
    return watcher;
  }

  const configurationListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('folderProfiles.foldersProfilesFilePath')) {
      yamlWatcher.dispose();
      yamlWatcher = createYamlWatcher();
      webviewProvider.postProfilesUpdate();
    }
  });

  context.subscriptions.push(
    createFromSelectionCommand,
    refreshCommand,
    openConfigFileCommand,
    toggleProfileCommand,
    deleteProfileCommand,
    configurationListener,
    { dispose: () => yamlWatcher.dispose() }
  );

  // Re-apply profiles flagged for auto-sync (MD5 check against their manifests)
  folderSyncService
    .syncOnStartup()
    .then(() => webviewProvider.postProfilesUpdate())
    .catch(err => console.error('[FolderProfiles] Startup sync failed:', err));
}
