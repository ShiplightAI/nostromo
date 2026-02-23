/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-syntax, no-restricted-globals */

interface IShellConfiguration {
	remoteAuthority: string;
	serverBasePath: string;
	productPath: string;
}

interface IWorktreeInfo {
	path: string;
	head: string;
	branch: string;
	isBare: boolean;
}

interface IRepoWorktreeResult {
	repoUri: string;
	worktrees: IWorktreeInfo[];
	error?: string;
}

interface IBrowseResult {
	path: string;
	entries: { name: string; isDirectory: boolean }[];
	parent: string | null;
}

const MAX_IFRAMES = 5;
const STORAGE_KEY = 'shell.trackedRepositories';
const LAST_BROWSE_PATH_KEY = 'shell.lastBrowsePath';

class ShellApplication {

	private readonly config: IShellConfiguration;
	private readonly repoListEl: HTMLElement;
	private readonly iframeContainer: HTMLElement;
	private readonly iframes = new Map<string, HTMLIFrameElement>();
	private readonly iframeLRU: string[] = [];
	private activeWorktreePath: string | null = null;
	private trackedRepos: string[] = [];
	private repoWorktrees = new Map<string, IWorktreeInfo[]>();
	private _activePopupDismiss: (() => void) | null = null;

	constructor() {
		const configElement = document.getElementById('vscode-shell-configuration');
		const configAttr = configElement?.getAttribute('data-settings');
		if (!configAttr) {
			throw new Error('Missing shell configuration element');
		}
		this.config = JSON.parse(configAttr);
		this.repoListEl = document.getElementById('repo-list')!;
		this.iframeContainer = document.getElementById('iframe-container')!;

		// Load tracked repos from localStorage
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			try {
				this.trackedRepos = JSON.parse(stored);
			} catch {
				this.trackedRepos = [];
			}
		}

		this._setupEventListeners();
		this._showEmptyState();

		if (this.trackedRepos.length > 0) {
			this.refreshWorktrees();
		}

		// Check if URL has ?folder= param — auto-activate that worktree
		const urlParams = new URLSearchParams(window.location.search);
		const folderParam = urlParams.get('folder');
		if (folderParam) {
			// Extract the path from vscode-remote URI if needed
			try {
				const folderUrl = new URL(folderParam);
				if (folderUrl.protocol === 'vscode-remote:') {
					this.activeWorktreePath = folderUrl.pathname;
				} else {
					this.activeWorktreePath = folderParam;
				}
			} catch {
				this.activeWorktreePath = folderParam;
			}
		}
	}

	private _setupEventListeners(): void {
		document.getElementById('refresh-btn')!.addEventListener('click', () => {
			this.refreshWorktrees();
		});

		document.getElementById('add-repo-btn')!.addEventListener('click', () => {
			this._showAddRepoMenu();
		});

		window.addEventListener('message', event => {
			// Handle messages from iframes
			if (event.data?.type === 'shell.switchWorktree') {
				this.switchToWorktree(event.data.path);
			}
		});

		// Resize handle drag
		const resizeHandle = document.getElementById('resize-handle')!;
		const sidebar = document.getElementById('shell-sidebar')!;
		let startX = 0;
		let startWidth = 0;

		const onMouseMove = (e: MouseEvent) => {
			const newWidth = startWidth + (e.clientX - startX);
			const clamped = Math.max(200, Math.min(400, newWidth));
			sidebar.style.width = `${clamped}px`;
		};

		const onMouseUp = () => {
			resizeHandle.classList.remove('dragging');
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			// Remove iframe pointer-events block
			this.iframeContainer.style.pointerEvents = '';
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};

		resizeHandle.addEventListener('mousedown', e => {
			e.preventDefault();
			startX = e.clientX;
			startWidth = sidebar.getBoundingClientRect().width;
			resizeHandle.classList.add('dragging');
			document.body.style.cursor = 'col-resize';
			document.body.style.userSelect = 'none';
			// Block iframe from stealing mouse events during drag
			this.iframeContainer.style.pointerEvents = 'none';
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		});
	}

	private _buildPath(...segments: string[]): string {
		// Join path segments and collapse double slashes (except after protocol like http://)
		const joined = segments.join('/');
		return joined.replace(/(?<!:)\/\/+/g, '/');
	}

	private _showEmptyState(): void {
		if (this.iframeContainer.querySelectorAll('iframe').length === 0 && !this.iframeContainer.querySelector('.empty-state')) {
			const empty = document.createElement('div');
			empty.className = 'empty-state';

			const icon = document.createElement('div');
			icon.className = 'empty-state-icon';
			icon.textContent = '\u{1F4C2}';

			const title = document.createElement('div');
			title.className = 'empty-state-title';
			title.textContent = 'No Worktree Selected';

			const subtitle = document.createElement('div');
			subtitle.className = 'empty-state-subtitle';
			subtitle.textContent = 'Add a repository to get started, then select a worktree to open.';

			const btn = document.createElement('button');
			btn.className = 'empty-state-btn';
			btn.textContent = '+ Add Repository';
			btn.addEventListener('click', () => {
				this._showAddRepoMenu();
			});

			empty.appendChild(icon);
			empty.appendChild(title);
			empty.appendChild(subtitle);
			empty.appendChild(btn);
			this.iframeContainer.appendChild(empty);
		}
	}

	private _removeEmptyState(): void {
		const empty = this.iframeContainer.querySelector('.empty-state');
		if (empty) {
			empty.remove();
		}
	}

	private _dismissActivePopup(): void {
		if (this._activePopupDismiss) {
			this._activePopupDismiss();
			this._activePopupDismiss = null;
		}
	}

	private _showAddRepoMenu(): void {
		this._dismissActivePopup();

		const footer = document.querySelector('.sidebar-footer') as HTMLElement;
		if (!footer) {
			return;
		}

		const menu = document.createElement('div');
		menu.className = 'add-repo-menu';

		const items = [
			{ label: 'Browse Folder...', action: () => { dismiss(); this._browseAndAddRepo(); } },
			{ label: 'Clone Repository...', action: () => { dismiss(); this._showCloneFlow(); } }
		];

		let focusedIndex = -1;

		const updateFocus = () => {
			menu.querySelectorAll('.add-repo-menu-item').forEach((el, i) => {
				el.classList.toggle('focused', i === focusedIndex);
			});
		};

		for (const item of items) {
			const el = document.createElement('div');
			el.className = 'add-repo-menu-item';
			el.textContent = item.label;
			el.addEventListener('click', item.action);
			menu.appendChild(el);
		}

		const dismiss = () => {
			menu.remove();
			document.removeEventListener('mousedown', outsideClickHandler);
			document.removeEventListener('keydown', keyHandler);
			this._activePopupDismiss = null;
		};

		const outsideClickHandler = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) {
				dismiss();
			}
		};

		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				dismiss();
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				focusedIndex = Math.min(focusedIndex + 1, items.length - 1);
				updateFocus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				focusedIndex = Math.max(focusedIndex - 1, 0);
				updateFocus();
			} else if (e.key === 'Enter' && focusedIndex >= 0) {
				e.preventDefault();
				items[focusedIndex].action();
			}
		};

		// Delay attaching outside-click so the current click doesn't close it
		setTimeout(() => {
			document.addEventListener('mousedown', outsideClickHandler);
		}, 0);
		document.addEventListener('keydown', keyHandler);

		footer.appendChild(menu);
		this._activePopupDismiss = dismiss;
	}

	private async _browseAndAddRepo(): Promise<void> {
		const selectedPath = await this._showFolderPicker('browse');
		if (!selectedPath) {
			return;
		}
		const repoUri = `file://${selectedPath}`;
		if (!this.trackedRepos.includes(repoUri)) {
			this.trackedRepos.push(repoUri);
			this._saveTrackedRepos();
		}
		await this.refreshWorktrees();
	}

	private async _fetchDirectoryListing(path: string, showHidden: boolean): Promise<IBrowseResult> {
		const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/browse');
		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, showHidden })
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(text || `HTTP ${response.status}`);
		}

		return response.json();
	}

	private async _showFolderPicker(mode: 'browse' | 'cloneDest'): Promise<string | null> {
		return new Promise<string | null>(resolve => {
			const overlay = document.createElement('div');
			overlay.className = 'folder-picker-overlay';

			const picker = document.createElement('div');
			picker.className = 'folder-picker';

			// Header
			const header = document.createElement('div');
			header.className = 'folder-picker-header';

			const pathInput = document.createElement('input');
			pathInput.className = 'folder-picker-path-input';
			pathInput.type = 'text';
			pathInput.placeholder = 'Enter path...';
			pathInput.spellcheck = false;

			let showHidden = false;
			const toggleHiddenBtn = document.createElement('button');
			toggleHiddenBtn.className = 'folder-picker-toggle-hidden';
			toggleHiddenBtn.textContent = 'Show Hidden';
			toggleHiddenBtn.addEventListener('click', () => {
				showHidden = !showHidden;
				toggleHiddenBtn.classList.toggle('active', showHidden);
				loadDirectory(currentPath);
			});

			header.appendChild(pathInput);
			header.appendChild(toggleHiddenBtn);

			// List
			const list = document.createElement('div');
			list.className = 'folder-picker-list';

			// Footer
			const footer = document.createElement('div');
			footer.className = 'folder-picker-footer';

			const statusText = document.createElement('span');
			statusText.className = 'folder-picker-status';

			const btnRow = document.createElement('div');
			btnRow.style.display = 'flex';
			btnRow.style.gap = '8px';

			const cancelBtn = document.createElement('button');
			cancelBtn.className = 'folder-picker-btn folder-picker-btn-cancel';
			cancelBtn.textContent = 'Cancel';

			const selectBtn = document.createElement('button');
			selectBtn.className = 'folder-picker-btn folder-picker-btn-select';
			selectBtn.textContent = mode === 'cloneDest' ? 'Select Destination' : 'Select Folder';

			btnRow.appendChild(cancelBtn);
			btnRow.appendChild(selectBtn);
			footer.appendChild(statusText);
			footer.appendChild(btnRow);

			picker.appendChild(header);
			picker.appendChild(list);
			picker.appendChild(footer);
			overlay.appendChild(picker);

			let currentPath = localStorage.getItem(LAST_BROWSE_PATH_KEY) || '';
			let focusedIndex = -1;
			let entries: { name: string; isDirectory: boolean }[] = [];
			let parentPath: string | null = null;

			const dismiss = (result: string | null) => {
				overlay.remove();
				resolve(result);
			};

			const updateEntryFocus = () => {
				list.querySelectorAll('.folder-picker-entry').forEach((el, i) => {
					el.classList.toggle('focused', i === focusedIndex);
					if (i === focusedIndex) {
						el.scrollIntoView({ block: 'nearest' });
					}
				});
			};

			const renderEntries = () => {
				list.innerHTML = '';
				const totalEntries: { name: string; icon: string; action: () => void }[] = [];

				if (parentPath !== null) {
					totalEntries.push({
						name: '..',
						icon: '\u{2190}',
						action: () => loadDirectory(parentPath!)
					});
				}

				for (const entry of entries) {
					totalEntries.push({
						name: entry.name,
						icon: '\u{1F4C1}',
						action: () => loadDirectory(currentPath + '/' + entry.name)
					});
				}

				for (const item of totalEntries) {
					const el = document.createElement('div');
					el.className = 'folder-picker-entry';

					const iconSpan = document.createElement('span');
					iconSpan.className = 'folder-picker-entry-icon';
					iconSpan.textContent = item.icon;

					const nameSpan = document.createElement('span');
					nameSpan.className = 'folder-picker-entry-name';
					nameSpan.textContent = item.name;

					el.appendChild(iconSpan);
					el.appendChild(nameSpan);
					el.addEventListener('click', item.action);
					list.appendChild(el);
				}

				focusedIndex = -1;
				statusText.textContent = `${entries.length} folder${entries.length !== 1 ? 's' : ''}`;
			};

			const loadDirectory = async (path: string) => {
				try {
					statusText.textContent = 'Loading...';
					const result = await this._fetchDirectoryListing(path, showHidden);
					currentPath = result.path;
					parentPath = result.parent;
					entries = result.entries;
					pathInput.value = currentPath;
					localStorage.setItem(LAST_BROWSE_PATH_KEY, currentPath);
					renderEntries();
				} catch (err) {
					statusText.textContent = `Error: ${err}`;
				}
			};

			// Events
			cancelBtn.addEventListener('click', () => dismiss(null));
			selectBtn.addEventListener('click', () => dismiss(currentPath));

			overlay.addEventListener('mousedown', e => {
				if (e.target === overlay) {
					dismiss(null);
				}
			});

			pathInput.addEventListener('keydown', e => {
				if (e.key === 'Enter') {
					loadDirectory(pathInput.value.trim());
				} else if (e.key === 'Escape') {
					dismiss(null);
				}
			});

			const pickerKeyHandler = (e: KeyboardEvent) => {
				if (e.target === pathInput) {
					return; // let path input handle its own keys
				}
				const totalCount = (parentPath !== null ? 1 : 0) + entries.length;
				if (e.key === 'Escape') {
					e.preventDefault();
					dismiss(null);
				} else if (e.key === 'ArrowDown') {
					e.preventDefault();
					focusedIndex = Math.min(focusedIndex + 1, totalCount - 1);
					updateEntryFocus();
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					focusedIndex = Math.max(focusedIndex - 1, 0);
					updateEntryFocus();
				} else if (e.key === 'Enter' && focusedIndex >= 0) {
					e.preventDefault();
					const entryEls = list.querySelectorAll('.folder-picker-entry');
					(entryEls[focusedIndex] as HTMLElement)?.click();
				}
			};
			picker.addEventListener('keydown', pickerKeyHandler);

			document.body.appendChild(overlay);
			pathInput.focus();
			loadDirectory(currentPath);
		});
	}

	private _showQuickInput(options: { label: string; placeholder: string }): Promise<string | null> {
		return new Promise<string | null>(resolve => {
			const overlay = document.createElement('div');
			overlay.className = 'quick-input-overlay';

			const widget = document.createElement('div');
			widget.className = 'quick-input-widget';

			const label = document.createElement('div');
			label.className = 'quick-input-label';
			label.textContent = options.label;

			const input = document.createElement('input');
			input.className = 'quick-input-field';
			input.type = 'text';
			input.placeholder = options.placeholder;
			input.spellcheck = false;

			widget.appendChild(label);
			widget.appendChild(input);
			overlay.appendChild(widget);

			const dismiss = (result: string | null) => {
				overlay.remove();
				resolve(result);
			};

			input.addEventListener('keydown', e => {
				if (e.key === 'Enter') {
					const value = input.value.trim();
					dismiss(value || null);
				} else if (e.key === 'Escape') {
					dismiss(null);
				}
			});

			overlay.addEventListener('mousedown', e => {
				if (e.target === overlay) {
					dismiss(null);
				}
			});

			document.body.appendChild(overlay);
			input.focus();
		});
	}

	private async _showCloneFlow(): Promise<void> {
		// Step 1: Get the git URL
		const gitUrl = await this._showQuickInput({
			label: 'Enter the repository URL to clone',
			placeholder: 'https://github.com/user/repo.git'
		});
		if (!gitUrl) {
			return;
		}

		// Step 2: Pick destination directory
		const destDir = await this._showFolderPicker('cloneDest');
		if (!destDir) {
			return;
		}

		// Derive repo name from URL
		let repoName = gitUrl.split('/').pop() || 'repo';
		if (repoName.endsWith('.git')) {
			repoName = repoName.slice(0, -4);
		}
		const destPath = destDir + '/' + repoName;

		// Show loading overlay
		const loadingOverlay = document.createElement('div');
		loadingOverlay.className = 'loading-overlay';
		const loadingContent = document.createElement('div');
		loadingContent.className = 'loading-content';
		const spinner = document.createElement('div');
		spinner.className = 'loading-spinner';
		const loadingText = document.createElement('span');
		loadingText.textContent = 'Cloning repository...';
		loadingContent.appendChild(spinner);
		loadingContent.appendChild(loadingText);
		loadingOverlay.appendChild(loadingContent);
		document.body.appendChild(loadingOverlay);

		try {
			const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/clone');
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: gitUrl, destPath })
			});

			const result = await response.json();
			loadingOverlay.remove();

			if (result.success) {
				const repoUri = `file://${result.path}`;
				if (!this.trackedRepos.includes(repoUri)) {
					this.trackedRepos.push(repoUri);
					this._saveTrackedRepos();
				}
				await this.refreshWorktrees();
			} else {
				alert(`Clone failed: ${result.error}`);
			}
		} catch (err) {
			loadingOverlay.remove();
			alert(`Clone failed: ${err}`);
		}
	}

	private _removeRepository(repoUri: string): void {
		this.trackedRepos = this.trackedRepos.filter(r => r !== repoUri);
		this._saveTrackedRepos();
		this.repoWorktrees.delete(repoUri);
		this._renderRepoList();
	}

	private _saveTrackedRepos(): void {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(this.trackedRepos));
	}

	async refreshWorktrees(): Promise<void> {
		if (this.trackedRepos.length === 0) {
			this._renderRepoList();
			return;
		}

		try {
			const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/worktrees');
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoUris: this.trackedRepos })
			});

			if (!response.ok) {
				console.error('Failed to fetch worktrees:', response.statusText);
				return;
			}

			const results: IRepoWorktreeResult[] = await response.json();
			for (const result of results) {
				this.repoWorktrees.set(result.repoUri, result.worktrees);
			}
		} catch (err) {
			console.error('Failed to fetch worktrees:', err);
		}

		this._renderRepoList();
	}

	private _renderRepoList(): void {
		this.repoListEl.innerHTML = '';

		// Determine which repo (if any) contains the active worktree
		const hasActiveSession = this.activeWorktreePath !== null;
		let activeRepoUri: string | null = null;
		if (hasActiveSession) {
			for (const repoUri of this.trackedRepos) {
				const worktrees = this.repoWorktrees.get(repoUri) ?? [];
				if (worktrees.some(wt => wt.path === this.activeWorktreePath)) {
					activeRepoUri = repoUri;
					break;
				}
			}
		}

		for (const repoUri of this.trackedRepos) {
			const worktrees = this.repoWorktrees.get(repoUri) ?? [];
			const section = document.createElement('div');
			section.className = 'repo-section';

			// Repo header
			const header = document.createElement('div');
			header.className = 'repo-header';

			const expandIcon = document.createElement('span');
			expandIcon.className = 'expand-icon';
			expandIcon.textContent = '\u25BC';

			const repoName = document.createElement('span');
			try {
				const repoUrl = new URL(repoUri);
				repoName.textContent = repoUrl.pathname.split('/').filter(Boolean).pop() ?? repoUri;
			} catch {
				repoName.textContent = repoUri;
			}

			const addWtBtn = document.createElement('button');
			addWtBtn.className = 'add-wt-btn';
			addWtBtn.textContent = '+';
			addWtBtn.title = 'Add worktree';
			addWtBtn.addEventListener('click', e => {
				e.stopPropagation();
				this._addWorktree(repoUri);
			});

			const removeBtn = document.createElement('button');
			removeBtn.className = 'remove-btn';
			removeBtn.textContent = '\u00D7';
			removeBtn.title = 'Remove repository';
			removeBtn.addEventListener('click', e => {
				e.stopPropagation();
				this._removeRepository(repoUri);
			});

			header.appendChild(expandIcon);
			header.appendChild(repoName);
			header.appendChild(addWtBtn);
			header.appendChild(removeBtn);

			// Worktree list
			const wtList = document.createElement('div');
			wtList.className = 'worktree-list';

			// Collapse repos that don't contain the active worktree
			const shouldCollapse = hasActiveSession && repoUri !== activeRepoUri;
			if (shouldCollapse) {
				wtList.classList.add('collapsed');
				expandIcon.classList.add('collapsed');
			}

			header.addEventListener('click', () => {
				const collapsed = wtList.classList.toggle('collapsed');
				expandIcon.classList.toggle('collapsed', collapsed);
			});

			// Find the main worktree (first non-bare entry) — don't allow removing it
			const mainWorktree = worktrees.find(w => !w.isBare);

			for (const wt of worktrees) {
				const item = document.createElement('div');
				item.className = 'worktree-item';
				if (wt.path === this.activeWorktreePath) {
					item.classList.add('active');
				}

				const branchSpan = document.createElement('span');
				branchSpan.className = 'wt-branch';
				const branchName = wt.branch ? wt.branch.replace('refs/heads/', '') : wt.path.split('/').pop() ?? wt.path;
				branchSpan.textContent = branchName;
				branchSpan.title = wt.path;
				item.appendChild(branchSpan);

				if (wt.isBare) {
					const bareTag = document.createElement('span');
					bareTag.className = 'wt-bare-tag';
					bareTag.textContent = 'bare';
					item.appendChild(bareTag);
				}

				// Show archive button on non-main, non-bare worktrees
				if (!wt.isBare && wt !== mainWorktree) {
					const archiveBtn = document.createElement('button');
					archiveBtn.className = 'archive-btn';
					archiveBtn.textContent = '\u00D7';
					archiveBtn.title = 'Remove worktree';
					archiveBtn.addEventListener('click', e => {
						e.stopPropagation();
						this._archiveWorktree(repoUri, wt);
					});
					item.appendChild(archiveBtn);
				}

				item.addEventListener('click', () => {
					this.switchToWorktree(wt.path);
				});

				wtList.appendChild(item);
			}

			section.appendChild(header);
			section.appendChild(wtList);
			this.repoListEl.appendChild(section);
		}
	}

	private async _addWorktree(repoUri: string): Promise<void> {
		this._dismissActivePopup();

		const repoPath = repoUri.replace(/^file:\/\//, '');

		// Find the repo header element for positioning
		const headers = this.repoListEl.querySelectorAll('.repo-header');
		let anchorEl: HTMLElement | null = null;
		for (const h of headers) {
			const btn = h.querySelector('.add-wt-btn');
			if (btn) {
				// Check if this header's remove-btn corresponds to this repo
				const nameEl = h.querySelectorAll('span')[1];
				if (nameEl) {
					anchorEl = h as HTMLElement;
					break;
				}
			}
		}

		const menu = document.createElement('div');
		menu.className = 'add-repo-menu';

		const items = [
			{ label: 'New Branch...', action: () => { dismiss(); this._addWorktreeNewBranch(repoPath); } },
			{ label: 'Existing Branch...', action: () => { dismiss(); this._addWorktreeExistingBranch(repoPath); } }
		];

		let focusedIndex = -1;

		const updateFocus = () => {
			menu.querySelectorAll('.add-repo-menu-item').forEach((el, i) => {
				el.classList.toggle('focused', i === focusedIndex);
			});
		};

		for (const item of items) {
			const el = document.createElement('div');
			el.className = 'add-repo-menu-item';
			el.textContent = item.label;
			el.addEventListener('click', item.action);
			menu.appendChild(el);
		}

		const dismiss = () => {
			menu.remove();
			document.removeEventListener('mousedown', outsideClickHandler);
			document.removeEventListener('keydown', keyHandler);
			this._activePopupDismiss = null;
		};

		const outsideClickHandler = (e: MouseEvent) => {
			if (!menu.contains(e.target as Node)) {
				dismiss();
			}
		};

		const keyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				dismiss();
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				focusedIndex = Math.min(focusedIndex + 1, items.length - 1);
				updateFocus();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				focusedIndex = Math.max(focusedIndex - 1, 0);
				updateFocus();
			} else if (e.key === 'Enter' && focusedIndex >= 0) {
				e.preventDefault();
				items[focusedIndex].action();
			}
		};

		setTimeout(() => {
			document.addEventListener('mousedown', outsideClickHandler);
		}, 0);
		document.addEventListener('keydown', keyHandler);

		if (anchorEl) {
			anchorEl.style.position = 'relative';
			menu.style.top = '100%';
			menu.style.left = '0';
			menu.style.right = '0';
			menu.style.bottom = 'auto';
			menu.style.marginTop = '2px';
			menu.style.marginBottom = '0';
			anchorEl.appendChild(menu);
		} else {
			document.body.appendChild(menu);
		}

		this._activePopupDismiss = dismiss;
	}

	private async _addWorktreeNewBranch(repoPath: string): Promise<void> {
		const branchName = await this._showQuickInput({
			label: 'Enter new branch name',
			placeholder: 'feature/my-branch'
		});
		if (!branchName) {
			return;
		}

		try {
			const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/worktree-add');
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoPath, branchName, newBranch: true })
			});

			const result = await response.json();
			if (result.success) {
				await this.refreshWorktrees();
				this.switchToWorktree(result.path);
			} else {
				alert(`Failed to add worktree: ${result.error}`);
			}
		} catch (err) {
			alert(`Failed to add worktree: ${err}`);
		}
	}

	private async _addWorktreeExistingBranch(repoPath: string): Promise<void> {
		// Fetch branches
		let branches: string[];
		try {
			const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/branches');
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoPath })
			});
			const result = await response.json();
			branches = result.branches ?? [];
		} catch (err) {
			alert(`Failed to fetch branches: ${err}`);
			return;
		}

		if (branches.length === 0) {
			alert('No branches found.');
			return;
		}

		const selected = await this._showBranchPicker(branches);
		if (!selected) {
			return;
		}

		try {
			const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/worktree-add');
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoPath, branchName: selected, newBranch: false })
			});

			const result = await response.json();
			if (result.success) {
				await this.refreshWorktrees();
				this.switchToWorktree(result.path);
			} else {
				alert(`Failed to add worktree: ${result.error}`);
			}
		} catch (err) {
			alert(`Failed to add worktree: ${err}`);
		}
	}

	private _showBranchPicker(branches: string[]): Promise<string | null> {
		return new Promise<string | null>(resolve => {
			const overlay = document.createElement('div');
			overlay.className = 'quick-input-overlay';

			const widget = document.createElement('div');
			widget.className = 'quick-input-widget branch-picker';

			const label = document.createElement('div');
			label.className = 'quick-input-label';
			label.textContent = 'Select a branch';

			const filterInput = document.createElement('input');
			filterInput.className = 'quick-input-field';
			filterInput.type = 'text';
			filterInput.placeholder = 'Filter branches...';
			filterInput.spellcheck = false;

			const list = document.createElement('div');
			list.className = 'branch-picker-list';

			widget.appendChild(label);
			widget.appendChild(filterInput);
			widget.appendChild(list);
			overlay.appendChild(widget);

			let focusedIndex = -1;
			let filtered = branches.slice();

			const dismiss = (result: string | null) => {
				overlay.remove();
				resolve(result);
			};

			const renderList = () => {
				list.innerHTML = '';
				focusedIndex = filtered.length > 0 ? 0 : -1;
				for (let i = 0; i < filtered.length; i++) {
					const el = document.createElement('div');
					el.className = 'branch-picker-item';
					if (i === focusedIndex) {
						el.classList.add('focused');
					}
					el.textContent = filtered[i];
					el.addEventListener('click', () => dismiss(filtered[i]));
					list.appendChild(el);
				}
			};

			const updateFocus = () => {
				list.querySelectorAll('.branch-picker-item').forEach((el, i) => {
					el.classList.toggle('focused', i === focusedIndex);
					if (i === focusedIndex) {
						el.scrollIntoView({ block: 'nearest' });
					}
				});
			};

			filterInput.addEventListener('input', () => {
				const q = filterInput.value.toLowerCase();
				filtered = branches.filter(b => b.toLowerCase().includes(q));
				renderList();
			});

			filterInput.addEventListener('keydown', e => {
				if (e.key === 'Escape') {
					dismiss(null);
				} else if (e.key === 'ArrowDown') {
					e.preventDefault();
					focusedIndex = Math.min(focusedIndex + 1, filtered.length - 1);
					updateFocus();
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					focusedIndex = Math.max(focusedIndex - 1, 0);
					updateFocus();
				} else if (e.key === 'Enter' && focusedIndex >= 0) {
					e.preventDefault();
					dismiss(filtered[focusedIndex]);
				}
			});

			overlay.addEventListener('mousedown', e => {
				if (e.target === overlay) {
					dismiss(null);
				}
			});

			document.body.appendChild(overlay);
			filterInput.focus();
			renderList();
		});
	}

	private async _archiveWorktree(repoUri: string, wt: IWorktreeInfo): Promise<void> {
		const branchName = wt.branch ? wt.branch.replace('refs/heads/', '') : wt.path.split('/').pop() ?? wt.path;
		if (!confirm(`Remove worktree "${branchName}"?\n\nThis will delete the directory at:\n${wt.path}\n\nThe branch will be kept.`)) {
			return;
		}

		const repoPath = repoUri.replace(/^file:\/\//, '');

		try {
			const apiUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, '/api/worktree-remove');
			const response = await fetch(apiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repoPath, worktreePath: wt.path })
			});

			const result = await response.json();
			if (!result.success) {
				alert(`Failed to remove worktree: ${result.error}`);
				return;
			}

			// If the removed worktree was active, clear the iframe and show empty state
			if (this.activeWorktreePath === wt.path) {
				const iframe = this.iframes.get(wt.path);
				if (iframe) {
					iframe.remove();
					this.iframes.delete(wt.path);
					const lruIdx = this.iframeLRU.indexOf(wt.path);
					if (lruIdx !== -1) {
						this.iframeLRU.splice(lruIdx, 1);
					}
				}
				this.activeWorktreePath = null;

				// Update browser URL to remove folder param
				const newUrl = new URL(window.location.href);
				newUrl.searchParams.delete('folder');
				history.replaceState(null, '', newUrl.toString());

				this._showEmptyState();
			}

			await this.refreshWorktrees();
		} catch (err) {
			alert(`Failed to remove worktree: ${err}`);
		}
	}

	switchToWorktree(worktreePath: string): void {
		if (this.activeWorktreePath === worktreePath) {
			return;
		}

		this.activeWorktreePath = worktreePath;
		this._removeEmptyState();

		// Hide all iframes
		for (const iframe of this.iframes.values()) {
			iframe.classList.add('hidden');
		}

		// Show or create the iframe for this worktree
		let iframe = this.iframes.get(worktreePath);
		if (iframe) {
			iframe.classList.remove('hidden');
			// Update LRU
			const idx = this.iframeLRU.indexOf(worktreePath);
			if (idx !== -1) {
				this.iframeLRU.splice(idx, 1);
			}
			this.iframeLRU.push(worktreePath);
		} else {
			// Evict if at capacity
			while (this.iframes.size >= MAX_IFRAMES && this.iframeLRU.length > 0) {
				const evictPath = this.iframeLRU.shift()!;
				const evictIframe = this.iframes.get(evictPath);
				if (evictIframe) {
					evictIframe.remove();
					this.iframes.delete(evictPath);
				}
			}

			iframe = document.createElement('iframe');
			const folderUri = `vscode-remote://${this.config.remoteAuthority}${worktreePath}`;
			const iframeUrl = this._buildPath(this.config.serverBasePath, this.config.productPath, `/?folder=${encodeURIComponent(folderUri)}&embedded=true`);
			iframe.src = iframeUrl;
			iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
			this.iframeContainer.appendChild(iframe);
			this.iframes.set(worktreePath, iframe);
			this.iframeLRU.push(worktreePath);
		}

		// Update browser URL
		const folderUri = `vscode-remote://${this.config.remoteAuthority}${worktreePath}`;
		const newUrl = new URL(window.location.href);
		newUrl.searchParams.set('folder', folderUri);
		history.replaceState(null, '', newUrl.toString());

		// Update active styling in sidebar
		this.repoListEl.querySelectorAll('.worktree-item').forEach(el => {
			el.classList.remove('active');
		});
		this.repoListEl.querySelectorAll('.worktree-item').forEach(el => {
			const branchEl = el.querySelector('.wt-branch');
			if (branchEl && branchEl.getAttribute('title') === worktreePath) {
				el.classList.add('active');
			}
		});
	}
}

new ShellApplication();
