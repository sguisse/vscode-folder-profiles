import * as vscode from 'vscode';
import * as path from 'path';
import * as YAML from 'yaml';
import { FolderProfile, FoldersProfilesConfig } from '../types';
import { getProfilesFilePath, resolveConfiguredUri } from '../settings';

export class ProfileStorage {
  constructor(private readonly workspaceRoot: vscode.Uri) {}

  /** Resolved from the `folderProfiles.foldersProfilesFilePath` setting on every access. */
  public get configFileUri(): vscode.Uri {
    return resolveConfiguredUri(this.workspaceRoot, getProfilesFilePath());
  }

  /**
   * Loads YAML configuration from the workspace.
   * Returns an empty profile list if the file does not exist yet.
   */
  public async loadConfig(): Promise<FoldersProfilesConfig> {
    try {
      const fileBytes = await vscode.workspace.fs.readFile(this.configFileUri);
      const text = Buffer.from(fileBytes).toString('utf8');
      const parsed = YAML.parse(text);

      if (parsed && Array.isArray(parsed.profiles)) {
        return {
          profiles: parsed.profiles.map((p: any) => ({
            name: String(p.name || ''),
            description: p.description ? String(p.description) : '',
            tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
            enabled: Boolean(p.enabled),
            autoSync: Boolean(p.autoSync),
            folders: Array.isArray(p.folders) ? p.folders.map(String) : [],
            manifestPath: String(p.manifestPath || ''),
            manifestMD5: p.manifestMD5 ? String(p.manifestMD5) : undefined
          }))
        };
      }
      return { profiles: [] };
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { profiles: [] };
      }
      console.warn('[ProfileStorage] Failed to read or parse YAML config file:', error);
      return { profiles: [] };
    }
  }

  /**
   * Atomically saves YAML configuration.
   * Ensures the parent folder of the configuration file exists before writing.
   */
  public async saveConfig(config: FoldersProfilesConfig): Promise<void> {
    const configUri = this.configFileUri;
    const parentFolderUri = vscode.Uri.file(path.dirname(configUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentFolderUri);

    const yamlContent = YAML.stringify(config, {
      indent: 2,
      singleQuote: false
    });

    const tempFileUri = vscode.Uri.joinPath(
      parentFolderUri,
      `${path.basename(configUri.fsPath)}.tmp.${Date.now()}`
    );

    const bytes = Buffer.from(yamlContent, 'utf8');

    // Atomic write via temporary file rename
    await vscode.workspace.fs.writeFile(tempFileUri, bytes);
    await vscode.workspace.fs.rename(tempFileUri, configUri, { overwrite: true });
  }

  /**
   * Retrieves an existing profile by name (case-insensitive).
   */
  public async getProfile(name: string): Promise<FolderProfile | undefined> {
    const config = await this.loadConfig();
    return config.profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Adds or updates a profile in the configuration.
   */
  public async upsertProfile(profile: FolderProfile): Promise<void> {
    const config = await this.loadConfig();
    const existingIndex = config.profiles.findIndex(
      p => p.name.toLowerCase() === profile.name.toLowerCase()
    );

    if (existingIndex >= 0) {
      config.profiles[existingIndex] = profile;
    } else {
      config.profiles.push(profile);
    }

    await this.saveConfig(config);
  }

  /**
   * Updates selected fields of a profile.
   */
  public async patchProfile(
    name: string,
    patch: Partial<Pick<FolderProfile, 'enabled' | 'autoSync' | 'manifestMD5'>>
  ): Promise<FolderProfile | undefined> {
    const config = await this.loadConfig();
    const target = config.profiles.find(p => p.name === name);
    if (target) {
      Object.assign(target, patch);
      await this.saveConfig(config);
      return target;
    }
    return undefined;
  }

  /**
   * Updates the enabled state of a profile.
   */
  public async setProfileEnabled(name: string, enabled: boolean): Promise<FolderProfile | undefined> {
    return this.patchProfile(name, { enabled });
  }

  /**
   * Deletes a profile by name.
   */
  public async deleteProfile(name: string): Promise<boolean> {
    const config = await this.loadConfig();
    const initialLength = config.profiles.length;
    config.profiles = config.profiles.filter(p => p.name !== name);

    if (config.profiles.length !== initialLength) {
      await this.saveConfig(config);
      return true;
    }
    return false;
  }
}