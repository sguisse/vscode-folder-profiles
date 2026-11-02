# Folder Profiles Manager & Sync for VS Code

A VS Code extension to capture, bundle, and synchronize redundant folder profiles via XML manifests and YAML configuration.

## Features

- **Explorer Context Integration**: Select one or multiple folders and/or files in the Explorer, right-click and choose **Folder Profiles: Create / Update Profile...**.
- **XML Manifest Bundling**: Scans folder structures and stores file contents in CDATA blocks, safely escaping closing tags (`]]>`).
- **Single Source of Truth**: Profiles are persisted in a YAML file (default `.vscode/.folders_profiles.yaml`), which can be opened from the icon in the view header.
- **Auto-sync on load**: Each profile card has a toggle (orange = off, green = on). When on, the profile is re-synchronized when the extension loads. The MD5 of the XML manifest is stored in the profile (`manifestMD5`); if the manifest changed, the profile's folders/files are first moved to the trash (so obsolete ones are not kept) and then fully re-applied from the manifest. If the MD5 is unchanged, only missing items are restored.
- **Interactive Webview**: Custom sidebar panel with VS Code theme token integration, toggle switches, tags, folder chips, and an interactive popover for profiles with more than 5 folders.
- **Folder Synchronization**:
  - **Enable (toggle on)**: Restores all directories and files from the XML manifest into the workspace.
  - **Disable (toggle off)**: Prompts for confirmation and moves profile folders to trash.

## Settings

| Setting | Default | Description |
|---|---|---|
| `folderProfiles.manifestsFolderPath` | `.vscode/manifests` | Folder where the XML manifests are written. |
| `folderProfiles.foldersProfilesFilePath` | `.vscode/.folders_profiles.yaml` | YAML file storing the profiles (never prompted). |

## Local Development & Debugging

### 1. Install Dependencies
```bash
npm install
```

### 2. Compile and Bundle
```bash
# One-time build (type-check + esbuild bundle)
npm run build

# Or continuous watch mode during development
npm run watch
```

### 3. Launch Extension Host
1. Open this repository in VS Code.
2. Press `F5` (or open the **Run & Debug** view and select **Run Extension**).
3. A new **[Extension Development Host]** window will open.
4. In the test window, open any workspace containing folders to test creation and synchronization.