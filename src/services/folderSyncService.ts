import * as vscode from 'vscode';
import { FolderProfile } from '../types';
import { ProfileStorage } from './profileStorage';
import { ManifestService } from './manifestService';
import { getProfilesFilePath, resolveInsideWorkspace } from '../settings';

export class FolderSyncService {
  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly storage: ProfileStorage,
    private readonly manifestService: ManifestService
  ) {}

  /**
   * Activates a profile: restores all files from the XML manifest.
   */
  public async activateProfile(profile: FolderProfile): Promise<boolean> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Activating profile "${profile.name}"...`,
        cancellable: false
      },
      async progress => {
        try {
          progress.report({ message: 'Restoring files from manifest...' });
          const count = await this.manifestService.restoreManifest(profile.manifestPath);
          const md5 = await this.manifestService.computeManifestMd5(profile.manifestPath);

          await this.storage.patchProfile(profile.name, { enabled: true, manifestMD5: md5 });
          vscode.window.showInformationMessage(
            `Profile "${profile.name}" successfully activated (${count} file(s) synchronized).`
          );
          return true;
        } catch (error: any) {
          vscode.window.showErrorMessage(
            `Error activating profile "${profile.name}": ${error.message || error}`
          );
          return false;
        }
      }
    );
  }

  /**
   * Called when the extension loads: re-synchronizes every enabled profile
   * that has auto-sync turned on.
   */
  public async syncOnStartup(): Promise<void> {
    const config = await this.storage.loadConfig();
    const synced: string[] = [];

    for (const profile of config.profiles) {
      if (!profile.enabled || !profile.autoSync) {
        continue;
      }
      try {
        if (await this.syncProfileIfNeeded(profile)) {
          synced.push(profile.name);
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(
          `Error synchronizing profile "${profile.name}": ${error.message || error}`
        );
      }
    }

    if (synced.length > 0) {
      vscode.window.showInformationMessage(
        `Folder Profiles synchronized: ${synced.join(', ')}.`
      );
    }
  }

  /**
   * Compares the MD5 of the manifest on disk with the one stored in the profile.
   * - MD5 changed: remove the referenced folders/files first (so obsolete ones are
   *   not kept), then fully re-apply the manifest.
   * - MD5 unchanged: only restore referenced paths that are missing.
   * Returns true when something was restored.
   */
  private async syncProfileIfNeeded(profile: FolderProfile): Promise<boolean> {
    const currentMd5 = await this.manifestService.computeManifestMd5(profile.manifestPath);
    if (!currentMd5) {
      vscode.window.showWarningMessage(
        `Manifest not found for profile "${profile.name}": ${profile.manifestPath}`
      );
      return false;
    }

    const md5Changed = profile.manifestMD5 !== undefined && profile.manifestMD5 !== currentMd5;
    const missing = await this.hasMissingPaths(profile);

    if (!md5Changed && !missing) {
      if (profile.manifestMD5 !== currentMd5) {
        await this.storage.patchProfile(profile.name, { manifestMD5: currentMd5 });
      }
      return false;
    }

    if (md5Changed) {
      await this.removeProfilePaths(profile);
    }
    await this.manifestService.restoreManifest(profile.manifestPath);
    await this.storage.patchProfile(profile.name, { manifestMD5: currentMd5 });
    return true;
  }

  private async hasMissingPaths(profile: FolderProfile): Promise<boolean> {
    for (const relPath of profile.folders) {
      const uri = resolveInsideWorkspace(this.workspaceRoot, relPath);
      if (!uri) {
        continue;
      }
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * Moves the profile folders/files to the trash, never touching the workspace
   * root, anything outside it, or the manifest/profiles files themselves.
   */
  private async removeProfilePaths(profile: FolderProfile): Promise<void> {
    const protectedPaths = [profile.manifestPath, getProfilesFilePath()].map(p =>
      p.replace(/\\/g, '/').replace(/^\.\//, '')
    );

    for (const relPath of profile.folders) {
      const uri = resolveInsideWorkspace(this.workspaceRoot, relPath);
      if (!uri) {
        console.warn(`[FolderSyncService] Refusing to remove unsafe path: ${relPath}`);
        continue;
      }
      const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (protectedPaths.some(p => p === normalized || p.startsWith(`${normalized}/`))) {
        console.warn(`[FolderSyncService] Skipping removal of ${relPath}: contains profile metadata.`);
        continue;
      }
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      } catch (deleteError) {
        console.warn(`[FolderSyncService] Deletion skipped for ${relPath}:`, deleteError);
      }
    }
  }

  /**
   * Deactivates a profile: prompts the user before removing folders from the workspace.
   */
  public async deactivateProfile(profile: FolderProfile): Promise<boolean> {
    const foldersListText = profile.folders.map(f => `  • ${f}`).join('\n');
    const confirmChoice = await vscode.window.showWarningMessage(
      `Deactivating profile "${profile.name}". Would you like to remove the profile folders/files from the workspace?\n\n${foldersListText}`,
      { modal: true },
      'Delete from workspace',
      'Keep files'
    );

    if (!confirmChoice) {
      return false;
    }

    if (confirmChoice === 'Delete from workspace') {
      try {
        await this.removeProfilePaths(profile);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to delete some folders: ${err.message || err}`
        );
      }
    }

    await this.storage.setProfileEnabled(profile.name, false);
    vscode.window.showInformationMessage(
      `Profile "${profile.name}" deactivated.${confirmChoice === 'Delete from workspace' ? ' Items moved to trash.' : ''}`
    );
    return true;
  }

  /**
   * Toggles or sets the enabled status of a profile.
   */
  public async toggleProfile(profileName: string, requestedState?: boolean): Promise<boolean> {
    const profile = await this.storage.getProfile(profileName);
    if (!profile) {
      vscode.window.showErrorMessage(`Profile not found: "${profileName}".`);
      return false;
    }

    const nextState = requestedState !== undefined ? requestedState : !profile.enabled;

    if (nextState) {
      return await this.activateProfile(profile);
    } else {
      return await this.deactivateProfile(profile);
    }
  }

  /**
   * Permanently deletes a profile from the YAML configuration after confirmation.
   */
  public async deleteProfile(profileName: string): Promise<boolean> {
    const profile = await this.storage.getProfile(profileName);
    if (!profile) {
      return false;
    }

    const answer = await vscode.window.showWarningMessage(
      `Are you sure you want to permanently delete profile "${profileName}" from configuration?`,
      { modal: true },
      'Delete Profile',
      'Cancel'
    );

    if (answer !== 'Delete Profile') {
      return false;
    }

    const deleted = await this.storage.deleteProfile(profileName);
    if (deleted) {
      vscode.window.showInformationMessage(`Profile "${profileName}" deleted.`);
    }
    return deleted;
  }
}