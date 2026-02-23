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

const MAX_IFRAMES = 5;
const STORAGE_KEY = 'shell.trackedRepositories';

class ShellApplication {

	private readonly config: IShellConfiguration;
	private readonly repoListEl: HTMLElement;
	private readonly iframeContainer: HTMLElement;
	private readonly iframes = new Map<string, HTMLIFrameElement>();
	private readonly iframeLRU: string[] = [];
	private activeWorktreePath: string | null = null;
	private trackedRepos: string[] = [];
	private repoWorktrees = new Map<string, IWorktreeInfo[]>();

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
			this._addRepository();
		});

		window.addEventListener('message', event => {
			// Handle messages from iframes
			if (event.data?.type === 'shell.switchWorktree') {
				this.switchToWorktree(event.data.path);
			}
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
			empty.textContent = 'Select a worktree to open';
			this.iframeContainer.appendChild(empty);
		}
	}

	private _removeEmptyState(): void {
		const empty = this.iframeContainer.querySelector('.empty-state');
		if (empty) {
			empty.remove();
		}
	}

	private _addRepository(): void {
		const addBtn = document.getElementById('add-repo-btn')!;

		// If input is already showing, focus it
		const existing = document.getElementById('add-repo-input') as HTMLInputElement | null;
		if (existing) {
			existing.focus();
			return;
		}

		// Create inline input
		const inputContainer = document.createElement('div');
		inputContainer.className = 'add-repo-input-container';

		const input = document.createElement('input');
		input.id = 'add-repo-input';
		input.className = 'add-repo-input';
		input.type = 'text';
		input.placeholder = '/absolute/path/to/repo';
		input.spellcheck = false;

		const dismiss = () => {
			inputContainer.remove();
			addBtn.style.display = '';
		};

		const submit = async () => {
			const path = input.value.trim();
			if (!path) {
				dismiss();
				return;
			}

			const repoUri = `file://${path}`;
			if (this.trackedRepos.includes(repoUri)) {
				dismiss();
				return;
			}

			this.trackedRepos.push(repoUri);
			this._saveTrackedRepos();
			dismiss();
			await this.refreshWorktrees();
		};

		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				submit();
			} else if (e.key === 'Escape') {
				dismiss();
			}
		});

		input.addEventListener('blur', () => {
			// Small delay so click events on the input can still fire
			setTimeout(() => {
				if (document.activeElement !== input) {
					dismiss();
				}
			}, 150);
		});

		inputContainer.appendChild(input);
		addBtn.style.display = 'none';
		addBtn.parentElement!.insertBefore(inputContainer, addBtn);
		input.focus();
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
			header.appendChild(removeBtn);

			// Worktree list
			const wtList = document.createElement('div');
			wtList.className = 'worktree-list';

			header.addEventListener('click', () => {
				const collapsed = wtList.classList.toggle('collapsed');
				expandIcon.classList.toggle('collapsed', collapsed);
			});

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
