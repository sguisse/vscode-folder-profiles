#!/bin/bash

# ===================================================================================================
# FILES EXPORTER - VS CODE MARKETPLACE DEPLOYMENT PIPELINE
# ===================================================================================================
# This script handles dependency verification, standard semantic version bumping,
# VSIX packaging, and secure publishing to the Microsoft VS Code Marketplace.
# ===================================================================================================

set -e

echo "🚀 Initiating VS Code Marketplace Deployment Pipeline..."

# ─── 1. Environment Verification ────────────────────────────────────────────────

if ! command -v npm &> /dev/null; then
    echo "❌ ERROR: 'npm' is not installed or not in PATH. Node.js is required for deployment."
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo "❌ ERROR: 'git' is not installed. Semantic versioning requires a Git repository."
    exit 1
fi

# Ensure workspace is clean before bumping version
if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️ WARNING: Your Git workspace is not clean. It is highly recommended to commit your changes before deploying."
    read -p "Do you want to continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "🛑 Deployment aborted."
        exit 1
    fi
fi

# ─── 2. Clean & Install Dependencies ──────────────────────────────────────────
echo "🧹 Cleaning previous build artifacts..."
rm -rf dist/*
rm -rf node_modules/*

echo "📦 Installing Node.js dependencies..."
npm run install:all

# ─── 3. Semantic Versioning ─────────────────────────────────────────────────────
echo "📈 Select semantic version bump type for the release:"
echo "  1) Patch (0.0.x) - Backwards-compatible bug fixes"
echo "  2) Minor (0.x.0) - Backwards-compatible new features"
echo "  3) Major (x.0.0) - Breaking changes / Major rewrite"
echo "  4) Skip version bump (Publish current version in package.json)"
read -p "Select an option [1-4]: " V_BUMP

case $V_BUMP in
    1)
        echo "⬆️ Bumping Patch version..."
        npm version patch
        ;;
    2)
        echo "⬆️ Bumping Minor version..."
        npm version minor
        ;;
    3)
        echo "⬆️ Bumping Major version..."
        npm version major
        ;;
    4)
        echo "⏭️ Skipping version bump."
        ;;
    *)
        echo "❌ Invalid selection. Aborting deployment."
        exit 1
        ;;
esac

# ─── 4. Packaging ──────────────────────────────────────────────────────────────
echo "🛠️ Packaging the VSIX bundle (executing pre-publish scripts)..."
# Uses npx to ensure we use the latest official Microsoft vsce compiler without global installs
npx @vscode/vsce package


# ─── 5. Publishing ──────────────────────────────────────────────────────────────
echo "🌐 Publishing to the Visual Studio Code Marketplace..."
# If this is your first time publishing, vsce will halt and prompt for your Azure DevOps PAT.
# https://dev.azure.com/sebguisse/_usersSettings/tokens
npx @vscode/vsce publish --pat "$AZURE_DEVOPS_EXT_PAT"


# ─── 6. Finalization ────────────────────────────────────────────────────────────
if [[ "$V_BUMP" -ne 4 ]]; then
    echo "☁️ Pushing version tag to remote Git repository..."
    git push --follow-tags
fi

echo "✅ Deployment pipeline executed successfully!"
echo "📢 Your extension is now live on the VS Code Marketplace. Please allow a few minutes for the changes to propagate."
echo "🌐 View your extension: https://marketplace.visualstudio.com/items?itemName=sguisse.folder-profiles"
echo "🔗 View your publisher profile: https://marketplace.visualstudio.com/manage/publishers/sguisse"
echo "🎉 Thank you for using the Folder Profiles extension! Happy coding! 🚀"
