import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { ManifestFileEntry, ParsedManifest } from '../types';
import { resolveConfiguredUri, resolveInsideWorkspace } from '../settings';

export interface GeneratedManifest {
  manifestPath: string;
  md5: string;
}

export class ManifestService {
  constructor(private readonly workspaceRoot: vscode.Uri) {}

  /**
   * Escapes CDATA closing tags `]]>` inside raw text content
   * by splitting the sequence into two adjacent CDATA blocks.
   */
  public static escapeCData(content: string): string {
    return content.replace(/\]\]>/g, ']]]]><![CDATA[>');
  }

  /**
   * Escapes standard XML reserved characters.
   */
  public static escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  public static md5(content: Uint8Array | string): string {
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Computes the MD5 of the manifest file currently on disk.
   * Returns undefined when the manifest does not exist.
   */
  public async computeManifestMd5(relativeManifestPath: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        resolveConfiguredUri(this.workspaceRoot, relativeManifestPath)
      );
      return ManifestService.md5(bytes);
    } catch {
      return undefined;
    }
  }

  /**
   * Scans the specified workspace-relative folders and/or files and builds an XML manifest.
   */
  public async generateManifest(
    relativePaths: string[],
    destinationRelativeManifestPath: string
  ): Promise<GeneratedManifest> {
    const fileEntries: ManifestFileEntry[] = [];

    for (const relPath of relativePaths) {
      const targetUri = vscode.Uri.joinPath(this.workspaceRoot, relPath);
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(targetUri);
      } catch {
        continue;
      }
      if (stat.type & vscode.FileType.Directory) {
        await this.collectFilesRecursively(targetUri, fileEntries);
      } else if (stat.type & vscode.FileType.File) {
        await this.collectFile(targetUri, path.basename(targetUri.fsPath), fileEntries);
      }
    }

    const xmlLines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<export>',
      '  <files>'
    ];

    for (const entry of fileEntries) {
      xmlLines.push('    <file>');
      xmlLines.push(`      <filename>${ManifestService.escapeXml(entry.filename)}</filename>`);
      xmlLines.push(`      <extension>${ManifestService.escapeXml(entry.extension)}</extension>`);
      xmlLines.push(`      <path>${ManifestService.escapeXml(entry.path)}</path>`);
      xmlLines.push(`      <content><![CDATA[${ManifestService.escapeCData(entry.content)}]]></content>`);
      xmlLines.push('    </file>');
    }

    xmlLines.push('  </files>');
    xmlLines.push('</export>');

    const xmlContent = xmlLines.join('\n');
    const destinationUri = resolveConfiguredUri(this.workspaceRoot, destinationRelativeManifestPath);

    // Ensure parent directory exists (e.g. .vscode/manifests)
    const parentDir = vscode.Uri.file(path.dirname(destinationUri.fsPath));
    await vscode.workspace.fs.createDirectory(parentDir);

    const bytes = Buffer.from(xmlContent, 'utf8');
    await vscode.workspace.fs.writeFile(destinationUri, bytes);
    return { manifestPath: destinationRelativeManifestPath, md5: ManifestService.md5(bytes) };
  }

  /**
   * Reads the XML manifest and restores all files and directories on disk.
   */
  public async restoreManifest(relativeManifestPath: string): Promise<number> {
    const manifestUri = resolveConfiguredUri(this.workspaceRoot, relativeManifestPath);
    const fileBytes = await vscode.workspace.fs.readFile(manifestUri);
    const xmlContent = Buffer.from(fileBytes).toString('utf8');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: false,
      cdataPropName: false
    });

    const parsed: ParsedManifest = parser.parse(xmlContent);
    const rawFiles = parsed.export?.files?.file;

    if (!rawFiles) {
      return 0;
    }

    const filesList: ManifestFileEntry[] = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
    let restoredCount = 0;

    for (const fileItem of filesList) {
      const relativeDirPath = (fileItem.path || '').trim();
      const filename = (fileItem.filename || '').trim();
      const ext = (fileItem.extension || '').trim();
      const content = fileItem.content !== undefined ? String(fileItem.content) : '';

      const fullName = ext ? `${filename}.${ext}` : filename;
      // A manifest may come from version control: never write outside the workspace.
      const targetDirUri = relativeDirPath
        ? resolveInsideWorkspace(this.workspaceRoot, relativeDirPath)
        : this.workspaceRoot;
      if (!targetDirUri || !fullName || fullName.includes('/') || fullName.includes('\\') || fullName === '..') {
        console.warn(`[ManifestService] Skipped unsafe manifest entry: ${relativeDirPath}/${fullName}`);
        continue;
      }
      const targetFileUri = vscode.Uri.joinPath(targetDirUri, fullName);

      await vscode.workspace.fs.createDirectory(targetDirUri);
      await vscode.workspace.fs.writeFile(targetFileUri, Buffer.from(content, 'utf8'));
      restoredCount++;
    }

    return restoredCount;
  }

  /**
   * Recursively collects files while skipping version control and dependency directories.
   */
  private async collectFilesRecursively(
    currentDirUri: vscode.Uri,
    entries: ManifestFileEntry[]
  ): Promise<void> {
    let dirContent: [string, vscode.FileType][];
    try {
      dirContent = await vscode.workspace.fs.readDirectory(currentDirUri);
    } catch {
      return;
    }

    for (const [name, fileType] of dirContent) {
      if (name === '.git' || name === 'node_modules' || name === '.DS_Store') {
        continue;
      }

      const itemUri = vscode.Uri.joinPath(currentDirUri, name);

      if (fileType === vscode.FileType.Directory) {
        await this.collectFilesRecursively(itemUri, entries);
      } else if (fileType === vscode.FileType.File) {
        await this.collectFile(itemUri, name, entries);
      }
    }
  }

  private async collectFile(
    fileUri: vscode.Uri,
    name: string,
    entries: ManifestFileEntry[]
  ): Promise<void> {
    try {
      const rawBytes = await vscode.workspace.fs.readFile(fileUri);
      const relativeFolder = path
        .relative(this.workspaceRoot.fsPath, path.dirname(fileUri.fsPath))
        .replace(/\\/g, '/');

      const parsedPath = path.parse(name);
      const ext = parsedPath.ext.startsWith('.') ? parsedPath.ext.substring(1) : parsedPath.ext;

      entries.push({
        filename: parsedPath.name,
        extension: ext,
        path: relativeFolder,
        content: Buffer.from(rawBytes).toString('utf8')
      });
    } catch (err) {
      console.warn(`[ManifestService] Could not read text file at ${fileUri.fsPath}:`, err);
    }
  }
}