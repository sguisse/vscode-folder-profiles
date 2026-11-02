#!/usr/bin/env node
/**
 * Applies a YAML "generation manifest" (file create/update/delete list) to the workspace.
 *
 * Features:
 * - Extracts YAML manifest content enclosed in ~~~~yaml code blocks if present.
 * - Auto-repairs `.tsx`, `.jsx`, and `.java` file content for common LLM syntax corruption signatures.
 * - Tracks and reports sanitization replacement counts per file at completion.
 * - Full AST syntax validation via TypeScript Compiler API (can be bypassed with --skipCheckSyntax).
 * - Double-check regex gate for residual JSX corruption signatures.
 * - Workspace rollback on build or syntax failure (skipped with warning if --disableRollback or --skipCheckSyntax is enabled).
 *
 * Usage:
 *   node scripts/dev-tools/apply-yaml-on-codebase.js path/to/manifest.yaml
 *   node scripts/dev-tools/apply-yaml-on-codebase.js path/to/manifest.yaml --skipCheckSyntax
 *   node scripts/dev-tools/apply-yaml-on-codebase.js path/to/manifest.yaml --disableRollback
 *   node scripts/dev-tools/apply-yaml-on-codebase.js path/to/manifest.yaml --skipNodeBuild
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from 'js-yaml';
import ts from 'typescript';

const WORKSPACE_ROOT = process.cwd();
const VALID_ACTIONS = new Set(['create', 'update', 'delete']);
const SYNTAX_CHECKED_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx']);
const SANITIZED_JSX_TSX_EXTENSIONS = new Set(['tsx', 'jsx']);
const SANITIZED_JAVA_EXTENSIONS = new Set(['java']);

// Pattern for common LLM JSX corruption signatures
const JSX_CORRUPTION_REGEX = /="\{|\}"|=>"[[:space:]]*>/;

/**
 * Pre-pass helper to extract YAML content enclosed between ~~~~yaml and ~~~~ block delimiters.
 * If no ~~~~yaml block is found or the extracted content is empty, returns the full raw text.
 */
function extractYamlContent(text) {
    if (typeof text !== 'string') return text;

    const regex = /~{4,}yaml[ \t]*\r?\n?([\s\S]*?)~{4,}/i;
    const match = text.match(regex);

    if (match && match[1] && match[1].trim().length > 0) {
        return match[1];
    }

    return text;
}

/**
 * Pre-pass auto-repair for common LLM generation/formatting corruptions on JSX/TSX content.
 * Returns the sanitized string and the total number of replacements made.
 */
function sanitizeJsxTsxContentWithCount(content) {
    if (typeof content !== 'string') return { content, count: 0 };

    let totalCount = 0;
    let result = content;

    const rules = [
        [/null \|>/g, '| null>'],
        [/ "\{\(\)">/g, '"{() =>'],
        [/=(?:")(\{.*?\})(?:")/g, '=$1'],
        [/="\{\((.*?)\)">/g, '={($1) =>'],
        [/"\{/g, '{'],
        [/\}"/g, '}'],
    ];

    for (const [regex, replacement] of rules) {
        const matches = result.match(regex);
        if (matches) {
            totalCount += matches.length;
            result = result.replace(regex, replacement);
        }
    }

    return { content: result, count: totalCount };
}

/**
 * Pre-pass auto-repair for common LLM generation/formatting corruptions on Java content.
 * Returns the sanitized string and the total number of replacements made.
 */
function sanitizeJavaContentWithCount(content) {
    if (typeof content !== 'string') return { content, count: 0 };

    let totalCount = 0;
    let result = content;

    const rules = [
        [/\\\$/g, '$'],
    ];

    for (const [regex, replacement] of rules) {
        const matches = result.match(regex);
        if (matches) {
            totalCount += matches.length;
            result = result.replace(regex, replacement);
        }
    }

    return { content: result, count: totalCount };
}

function fail(message) {
    console.error(`❌ ${message}`);
    process.exit(1);
}

function resolveTargetPath(entry, index) {
    if (!entry.filename || typeof entry.filename !== 'string') fail(`Entry #${index}: missing 'filename'.`);
    if (!entry.extension || typeof entry.extension !== 'string') fail(`Entry #${index}: missing 'extension'.`);
    if (!entry.path || typeof entry.path !== 'string') fail(`Entry #${index}: missing 'path'.`);
    if (!VALID_ACTIONS.has(entry.action)) fail(`Entry #${index}: 'action' must be one of create|update|delete.`);
    if (entry.action !== 'delete' && typeof entry.content !== 'string') {
        fail(`Entry #${index} (${entry.filename}.${entry.extension}): 'content' is required for action '${entry.action}'.`);
    }

    const targetDir = path.resolve(WORKSPACE_ROOT, entry.path);
    const targetFile = path.join(targetDir, `${entry.filename}.${entry.extension}`);

    const relative = path.relative(WORKSPACE_ROOT, targetFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        fail(`Entry #${index} (${entry.filename}.${entry.extension}): path escapes workspace root.`);
    }

    // Identify if target path is a directory instead of a file
    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
        console.error(`🚨 Illegal path operation: Target path points to an existing directory instead of a file: '${targetFile}'`);
        fail(`Entry #${index} (${entry.filename}.${entry.extension}): Target path is a directory: '${relative}'`);
    }

    return targetFile;
}

function checkSyntax(entry, targetFile) {
    const errors = [];

    // 1. Regex Pre-Check for residual LLM JSX corruption patterns
    const lines = entry.content.split('\n');
    lines.forEach((lineText, idx) => {
        if (JSX_CORRUPTION_REGEX.test(lineText)) {
            errors.push(`line ${idx + 1}: JSX corruption signature detected (quoted brace or truncated callback): "${lineText.trim()}"`);
        }
    });

    // 2. TypeScript Compiler AST Parsing
    const isJsx = targetFile.endsWith('.tsx') || targetFile.endsWith('.jsx');
    const result = ts.transpileModule(entry.content, {
        compilerOptions: {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.ESNext,
            jsx: isJsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
        },
        reportDiagnostics: true,
        fileName: targetFile,
    });

    (result.diagnostics || []).forEach((d) => {
        const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (d.file && d.start !== undefined) {
            const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
            errors.push(`line ${line + 1}, col ${character + 1}: ${message}`);
        } else {
            errors.push(message);
        }
    });

    return errors;
}

function main() {
    const cliArgs = process.argv.slice(2);
    const skipCheckSyntax = cliArgs.some((arg) => arg === '--skipCheckSyntax' || arg === 'skipCheckSyntax');
    const disableRollback = cliArgs.some((arg) => arg === '--disableRollback' || arg === 'disableRollback');
    const skipNodeBuild = cliArgs.some((arg) => arg === '--skipNodeBuild' || arg === 'skipNodeBuild' || arg === '—skipNodeBuild');
    const manifestArg = cliArgs.find((arg) => !arg.startsWith('--') && !arg.startsWith('—') && arg !== 'skipCheckSyntax' && arg !== 'disableRollback' && arg !== 'skipNodeBuild');

    if (!manifestArg) fail('Usage: node scripts/dev-tools/apply-yaml-on-codebase.js path/to/manifest.yaml [--skipCheckSyntax] [--disableRollback] [--skipNodeBuild]');

    const manifestPath = path.resolve(WORKSPACE_ROOT, manifestArg);
    if (!fs.existsSync(manifestPath)) fail(`Manifest not found: ${manifestPath}`);

    const rawManifestText = fs.readFileSync(manifestPath, 'utf8');
    const yamlContent = extractYamlContent(rawManifestText);

    let manifest;
    try {
        manifest = load(yamlContent);
    } catch (err) {
        fail(`Failed to parse YAML manifest: ${err.message}`);
    }

    const files = manifest?.generation?.files;
    if (!Array.isArray(files) || files.length === 0) fail("Manifest must define 'generation.files' as a non-empty array.");

    if (skipCheckSyntax) {
        console.log(`⚠️  skipCheckSyntax flag detected. Bypassing syntax validation for ${files.length} manifest entr${files.length === 1 ? 'y' : 'ies'}...`);
    } else {
        console.log(`🚀 Validating ${files.length} manifest entr${files.length === 1 ? 'y' : 'ies'}...`);
    }

    const resolvedEntries = [];
    const validationErrors = [];
    const sanitizationStats = []; // Tracks files with >0 replacements

    files.forEach((entry, index) => {
        const ext = (entry.extension || '').replace(/^\./, '').toLowerCase();

        // Apply sanitization strictly to .tsx and .jsx file extensions
        if (SANITIZED_JSX_TSX_EXTENSIONS.has(ext) && entry.content && typeof entry.content === 'string') {
            const { content: cleanedContent, count } = sanitizeJsxTsxContentWithCount(entry.content);
            entry.content = cleanedContent;

            if (count > 0) {
                const fileLabel = `${entry.path}/${entry.filename}.${entry.extension}`;
                sanitizationStats.push({ file: fileLabel, count });
            }
        }

        // Apply sanitization strictly to .java file extensions
        if (SANITIZED_JAVA_EXTENSIONS.has(ext) && entry.content && typeof entry.content === 'string') {
            const { content: cleanedContent, count } = sanitizeJavaContentWithCount(entry.content);
            entry.content = cleanedContent;

            if (count > 0) {
                const fileLabel = `${entry.path}/${entry.filename}.${entry.extension}`;
                sanitizationStats.push({ file: fileLabel, count });
            }
        }

        const targetFile = resolveTargetPath(entry, index);
        resolvedEntries.push({ entry, targetFile });

        if (entry.action === 'delete') return;

        if (!skipCheckSyntax && SYNTAX_CHECKED_EXTENSIONS.has(ext)) {
            const errors = checkSyntax(entry, targetFile);
            if (errors.length > 0) {
                validationErrors.push({ targetFile, errors });
            }
        }
    });

    if (validationErrors.length > 0) {
        console.error(`❌ Syntax validation failed for ${validationErrors.length} file(s). Zero disk writes performed.`);
        validationErrors.forEach(({ targetFile, errors }) => {
            console.error(`\n  ${path.relative(WORKSPACE_ROOT, targetFile)}`);
            errors.forEach((e) => console.error(`    - ${e}`));
        });
        process.exit(1);
    }

    console.log('✅ All entries ready. Creating backups and applying to disk...');

    // Create in-memory backups for atomic rollback if `npm run build` fails
    const backups = new Map();
    resolvedEntries.forEach(({ targetFile }) => {
        if (fs.existsSync(targetFile)) {
            if (fs.statSync(targetFile).isDirectory()) {
                console.error(`🚨 Cannot backup directory path: '${targetFile}'`);
                fail(`Target path is a directory, expected file: '${targetFile}'`);
            }
            backups.set(targetFile, fs.readFileSync(targetFile));
        } else {
            backups.set(targetFile, null);
        }
    });

    try {
        resolvedEntries.forEach(({ entry, targetFile }) => {
            const relativeDisplay = path.relative(WORKSPACE_ROOT, targetFile);
            if (entry.action === 'delete') {
                if (fs.existsSync(targetFile)) {
                    if (fs.statSync(targetFile).isDirectory()) {
                        fs.rmSync(targetFile, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(targetFile);
                    }
                    console.log(`🗑️ Removed existing file/directory: '${relativeDisplay}'`);
                }
                return;
            }

            fs.mkdirSync(path.dirname(targetFile), { recursive: true });
            const icon = entry.action === 'create' ? '➕ Creating new file' : '✏️ Modifying existing file';
            console.log(`${icon}: '${relativeDisplay}'`);
            fs.writeFileSync(targetFile, entry.content, 'utf8');
        });

        if (skipNodeBuild) {
            console.log('⚠️ Node build verification has been skipped.');
        } else {
            console.log('🧪 Running workspace build verification...');
            execFileSync('npm', ['run', 'build'], { cwd: WORKSPACE_ROOT, stdio: 'inherit' });
        }

    } catch (err) {
        if (disableRollback || skipCheckSyntax) {
            const flagUsed = disableRollback ? '--disableRollback' : '--skipCheckSyntax';
            console.warn('\n⚠️  WARNING: Workspace build verification failed!');
            console.warn(`⚠️  Because ${flagUsed} was enabled, rollback is SKIPPED and generated changes remain on disk.`);
            process.exit(1);
        } else {
            console.error('\n❌ Workspace build verification failed! Rolling back disk changes...');
            backups.forEach((content, file) => {
                if (content === null) {
                    if (fs.existsSync(file)) {
                        if (fs.statSync(file).isDirectory()) {
                            fs.rmSync(file, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(file);
                        }
                    }
                } else {
                    fs.writeFileSync(file, content);
                }
            });
            fail('Rollback complete. Workspace restored to clean state.');
        }
    }

    // Print sanitization report (only lists files with >0 replacements)
    if (sanitizationStats.length > 0) {
        console.log('\n🧹 Sanitization replacements applied:');
        sanitizationStats.forEach(({ file, count }) => {
            console.log(`  - ${file} : ${count}`);
        });
    }

    const commitMessage = manifest?.commit?.message;
    if (commitMessage) console.log(`\n${commitMessage}`);
}

main();
