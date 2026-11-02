/**
 * Schema for a folder profile in .vscode/.folders_profiles.yaml
 */
export interface FolderProfile {
  name: string;
  description?: string;
  tags: string[];
  enabled: boolean;
  /** Re-synchronize this profile from its manifest when the extension loads. */
  autoSync: boolean;
  /** Workspace-relative paths of the selected folders and/or files. */
  folders: string[];
  manifestPath: string;
  /** MD5 of the XML manifest content the profile was last synchronized with. */
  manifestMD5?: string;
}

/**
 * Root schema for .vscode/.folders_profiles.yaml
 */
export interface FoldersProfilesConfig {
  profiles: FolderProfile[];
}

/**
 * Internal structure of a captured file in the XML manifest
 */
export interface ManifestFileEntry {
  filename: string;
  extension: string;
  path: string;
  content: string;
}

/**
 * Parsed XML manifest structure
 */
export interface ParsedManifest {
  export?: {
    files?: {
      file?: ManifestFileEntry | ManifestFileEntry[];
    };
  };
}

/**
 * Incoming messages sent from the Webview to the extension host
 */
export type WebviewIncomingMessage =
  | { command: 'ready' }
  | { command: 'toggleProfile'; profileName: string; enabled: boolean }
  | { command: 'deleteProfile'; profileName: string }
  | { command: 'openFolder'; folderPath: string }
  | { command: 'openManifest'; manifestPath: string }
  | { command: 'toggleAutoSync'; profileName: string; enabled: boolean }
  | { command: 'openConfigFile' }
  | { command: 'refresh' };

/**
 * Outgoing messages sent from the extension host to the Webview
 */
export type WebviewOutgoingMessage =
  | { type: 'setProfiles'; profiles: FolderProfile[] }
  | { type: 'setLoading'; loading: boolean; message?: string };