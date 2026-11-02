(function () {
  const vscode = acquireVsCodeApi();

  const profilesListElement = document.getElementById('profiles-list');
  const counterElement = document.getElementById('profiles-counter');
  const btnOpenConfig = document.getElementById('btn-open-config');
  const popover = document.getElementById('folders-popover');
  const popoverContent = document.getElementById('popover-content');
  const popoverCloseBtn = document.getElementById('popover-close');

  let currentProfiles = [];
  let activePopoverAnchor = null;

  vscode.postMessage({ command: 'ready' });

  btnOpenConfig?.addEventListener('click', () => {
    vscode.postMessage({ command: 'openConfigFile' });
  });

  popoverCloseBtn?.addEventListener('click', hidePopover);

  document.addEventListener('click', (event) => {
    if (!popover.classList.contains('hidden')) {
      if (!popover.contains(event.target) && !event.target.classList.contains('more-folders-badge')) {
        hidePopover();
      }
    }
  });

  window.addEventListener('resize', () => {
    if (activePopoverAnchor && !popover.classList.contains('hidden')) {
      positionPopover(activePopoverAnchor);
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'setProfiles':
        currentProfiles = message.profiles || [];
        renderProfiles(currentProfiles);
        break;
    }
  });

  function renderProfiles(profiles) {
    if (counterElement) {
      counterElement.textContent = `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`;
    }

    if (!profiles || profiles.length === 0) {
      profilesListElement.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📁</div>
          <p>No folder profiles configured.</p>
          <p>Select folders and/or files in the Explorer, then right-click and choose
          <strong>Folder Profiles: Create / Update Profile...</strong></p>
        </div>
      `;
      return;
    }

    profilesListElement.innerHTML = '';

    profiles.forEach((profile) => {
      const card = document.createElement('div');
      card.className = `profile-card ${profile.enabled ? 'enabled' : 'disabled'}`;

      // Header
      const header = document.createElement('div');
      header.className = 'card-header';

      const headerLeft = document.createElement('div');
      headerLeft.className = 'card-header-left';

      // Toggle Switch
      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch-container';
      switchLabel.title = profile.enabled ? 'Deactivate profile' : 'Activate profile';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = profile.enabled;
      checkbox.addEventListener('change', () => {
        vscode.postMessage({
          command: 'toggleProfile',
          profileName: profile.name,
          enabled: checkbox.checked
        });
      });

      const slider = document.createElement('span');
      slider.className = 'switch-slider';

      switchLabel.appendChild(checkbox);
      switchLabel.appendChild(slider);

      const title = document.createElement('span');
      title.className = 'profile-name';
      title.textContent = profile.name;
      title.title = profile.name;

      headerLeft.appendChild(switchLabel);
      headerLeft.appendChild(title);

      const headerRight = document.createElement('div');
      headerRight.className = 'card-header-right';

      // Auto-sync toggle: orange when disabled, green when enabled
      const syncLabel = document.createElement('label');
      syncLabel.className = 'switch-container autosync';
      syncLabel.title = profile.autoSync
        ? 'Auto-sync on extension load: ON (click to disable)'
        : 'Auto-sync on extension load: OFF (click to enable)';

      const syncCheckbox = document.createElement('input');
      syncCheckbox.type = 'checkbox';
      syncCheckbox.checked = !!profile.autoSync;
      syncCheckbox.addEventListener('change', () => {
        vscode.postMessage({
          command: 'toggleAutoSync',
          profileName: profile.name,
          enabled: syncCheckbox.checked
        });
      });

      const syncSlider = document.createElement('span');
      syncSlider.className = 'switch-slider';

      syncLabel.appendChild(syncCheckbox);
      syncLabel.appendChild(syncSlider);
      headerRight.appendChild(syncLabel);

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-delete-profile';
      deleteBtn.innerHTML = '&times;';
      deleteBtn.title = 'Delete profile';
      deleteBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: 'deleteProfile',
          profileName: profile.name
        });
      });

      headerRight.appendChild(deleteBtn);
      header.appendChild(headerLeft);
      header.appendChild(headerRight);
      card.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'card-body';

      // Description
      const desc = document.createElement('div');
      desc.className = `profile-desc ${profile.description ? '' : 'empty'}`;
      desc.textContent = profile.description || 'No description provided.';
      body.appendChild(desc);

      // Tags
      if (profile.tags && profile.tags.length > 0) {
        const tagsRow = document.createElement('div');
        tagsRow.className = 'tags-row';
        profile.tags.forEach((tag) => {
          const tagBadge = document.createElement('span');
          tagBadge.className = 'tag-badge';
          tagBadge.textContent = tag;
          tagsRow.appendChild(tagBadge);
        });
        body.appendChild(tagsRow);
      }

      // Folders (max 5 visible)
      const foldersWrap = document.createElement('div');
      foldersWrap.className = 'folders-wrap';

      const visibleFolders = (profile.folders || []).slice(0, 5);
      const remainingFolders = (profile.folders || []).slice(5);

      visibleFolders.forEach((folderPath) => {
        const chip = document.createElement('span');
        chip.className = 'folder-chip';
        chip.textContent = folderPath;
        chip.title = `Reveal ${folderPath}`;
        chip.addEventListener('click', () => {
          vscode.postMessage({ command: 'openFolder', folderPath });
        });
        foldersWrap.appendChild(chip);
      });

      if (remainingFolders.length > 0) {
        const moreBadge = document.createElement('span');
        moreBadge.className = 'more-folders-badge';
        moreBadge.textContent = `+${remainingFolders.length} more...`;
        moreBadge.title = 'Show all items';

        moreBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          showPopover(profile.folders, moreBadge);
        });

        foldersWrap.appendChild(moreBadge);
      }

      body.appendChild(foldersWrap);
      card.appendChild(body);
      profilesListElement.appendChild(card);
    });
  }

  function showPopover(allFolders, anchorElement) {
    activePopoverAnchor = anchorElement;
    popoverContent.innerHTML = '';

    allFolders.forEach((folderPath) => {
      const chip = document.createElement('span');
      chip.className = 'folder-chip';
      chip.textContent = folderPath;
      chip.title = `Click to reveal in Explorer: ${folderPath}`;
      chip.addEventListener('click', () => {
        vscode.postMessage({ command: 'openFolder', folderPath });
        hidePopover();
      });
      popoverContent.appendChild(chip);
    });

    popover.classList.remove('hidden');
    positionPopover(anchorElement);
  }

  function positionPopover(anchorElement) {
    const rect = anchorElement.getBoundingClientRect();
    const popoverWidth = 260;
    const windowWidth = window.innerWidth;

    let left = rect.left;
    if (left + popoverWidth > windowWidth - 10) {
      left = windowWidth - popoverWidth - 10;
    }
    if (left < 10) {
      left = 10;
    }

    let top = rect.bottom + 6;
    if (top + 220 > window.innerHeight) {
      top = rect.top - 226;
    }

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function hidePopover() {
    popover.classList.add('hidden');
    activePopoverAnchor = null;
  }
})();