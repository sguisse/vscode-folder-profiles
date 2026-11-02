import * as vscode from 'vscode';
import * as path from 'path';

export const DEFAULT_MANIFESTS_FOLDER_PATH = '.vscode/manifests';
export const DEFAULT_PROFILES_FILE_PATH = '.vscode/.folders_profiles.yaml';

function readSetting(key: string, fallback: string): string {
  const raw = vscode.workspace.getConfiguration('folderProfiles').get<string>(key, fallback);
  const normalized = (raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  return normalized || fallback;
}

/** Workspace-relative folder where XML manifests are written (setting `folderProfiles.manifestsFolderPath`). */
export function getManifestsFolderPath(): string {
  return readSetting('manifestsFolderPath', DEFAULT_MANIFESTS_FOLDER_PATH);
}

/** Workspace-relative YAML file holding the profiles (setting `folderProfiles.foldersProfilesFilePath`). */
export function getProfilesFilePath(): string {
  return readSetting('foldersProfilesFilePath', DEFAULT_PROFILES_FILE_PATH);
}

/** Resolves a configured path (workspace-relative or absolute) to a Uri. */
export function resolveConfiguredUri(workspaceRoot: vscode.Uri, configuredPath: string): vscode.Uri {
  return path.isAbsolute(configuredPath)
    ? vscode.Uri.file(configuredPath)
    : vscode.Uri.joinPath(workspaceRoot, configuredPath);
}

/**
 * Resolves a path coming from a profile or manifest and refuses anything that
 * would escape the workspace (absolute paths, `..` segments).
 */
export function resolveInsideWorkspace(workspaceRoot: vscode.Uri, relativePath: string): vscode.Uri | undefined {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  if (
    !normalized ||
    normalized === '.' ||
    path.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return undefined;
  }
  return vscode.Uri.joinPath(workspaceRoot, normalized);
}
