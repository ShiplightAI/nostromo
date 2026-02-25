/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-syntax, no-restricted-globals */

import { IShellBackend, IShellSettings, IBrowseResult, IRepoWorktreeResult, ShellApplication } from '../../browser/workbench/shell.js';

/**
 * Electron shell window entry point.
 *
 * Uses IPC to communicate with main process services for
 * file browsing and git worktree operations. Workbench instances
 * are loaded as WebContentsView (managed by ShellViewManager in main process)
 * rather than iframes, so no HTTP server is needed.
 */

interface IPreloadGlobals {
	context: {
		resolveConfiguration(): Promise<Record<string, unknown>>;
	};
	ipcRenderer: {
		invoke(channel: string, ...args: unknown[]): Promise<unknown>;
	};
}

function createElectronBackend(windowId: number, ipcRenderer: IPreloadGlobals['ipcRenderer'], contentArea: HTMLElement): IShellBackend {
	return {
		async listDirectory(path: string, showHidden: boolean): Promise<IBrowseResult> {
			return ipcRenderer.invoke('vscode:shellWorktree-listDirectory', path, showHidden) as Promise<IBrowseResult>;
		},

		async getWorktrees(repoUris: string[]): Promise<IRepoWorktreeResult[]> {
			return ipcRenderer.invoke('vscode:shellWorktree-getWorktrees', repoUris) as Promise<IRepoWorktreeResult[]>;
		},

		async addWorktree(repoPath: string, branchName: string, newBranch: boolean): Promise<{ success: boolean; path?: string; error?: string }> {
			return ipcRenderer.invoke('vscode:shellWorktree-addWorktree', repoPath, branchName, newBranch) as Promise<{ success: boolean; path?: string; error?: string }>;
		},

		async removeWorktree(repoPath: string, worktreePath: string): Promise<{ success: boolean; error?: string }> {
			return ipcRenderer.invoke('vscode:shellWorktree-removeWorktree', repoPath, worktreePath) as Promise<{ success: boolean; error?: string }>;
		},

		async listBranches(repoPath: string): Promise<{ branches: string[] }> {
			return ipcRenderer.invoke('vscode:shellWorktree-listBranches', repoPath) as Promise<{ branches: string[] }>;
		},

		async cloneRepo(url: string, destPath: string): Promise<{ success: boolean; path?: string; error?: string }> {
			return ipcRenderer.invoke('vscode:shellWorktree-cloneRepo', url, destPath) as Promise<{ success: boolean; path?: string; error?: string }>;
		},

		async loadSettings(): Promise<IShellSettings> {
			return ipcRenderer.invoke('vscode:shellWorktree-loadSettings') as Promise<IShellSettings>;
		},

		async saveSettings(settings: IShellSettings): Promise<void> {
			await ipcRenderer.invoke('vscode:shellWorktree-saveSettings', settings);
		},

		switchToWorktree(worktreePath: string): void {
			ipcRenderer.invoke('vscode:shellView-activateWorktree', windowId, worktreePath);

			// Layout the WebContentsView to fill the content area
			const rect = contentArea.getBoundingClientRect();
			ipcRenderer.invoke('vscode:shellView-layoutActiveView', windowId, rect.x, rect.y, rect.width, rect.height);
		},

		onWorktreeRemoved(worktreePath: string): void {
			ipcRenderer.invoke('vscode:shellView-removeView', windowId, worktreePath);
		},

		async showOpenDialog(): Promise<string | null> {
			return ipcRenderer.invoke('vscode:shellWorktree-showOpenDialog') as Promise<string | null>;
		},

		setActiveViewVisible(visible: boolean): void {
			ipcRenderer.invoke('vscode:shellView-setActiveViewVisible', windowId, visible);
		}
	};
}

(async function () {
	const preloadGlobals: IPreloadGlobals = (window as unknown as { vscode: IPreloadGlobals }).vscode;
	const configuration = await preloadGlobals.context.resolveConfiguration();
	const ipcRenderer = preloadGlobals.ipcRenderer;

	// Apply theme colors from the workbench configuration
	const partsSplash = configuration.partsSplash as { colorInfo?: Record<string, string | undefined> } | undefined;
	if (partsSplash?.colorInfo) {
		const c = partsSplash.colorInfo;
		const vars: Record<string, string | undefined> = {
			'--shell-background': c.background,
			'--shell-foreground': c.foreground,
			'--shell-sidebar-bg': c.sideBarBackground,
			'--shell-sidebar-border': c.sideBarBorder,
			'--shell-titlebar-bg': c.titleBarBackground,
			'--shell-titlebar-border': c.titleBarBorder,
			'--shell-hover-bg': c.listHoverBackground,
			'--shell-active-bg': c.listActiveSelectionBackground,
		};
		const root = document.documentElement;
		for (const [prop, value] of Object.entries(vars)) {
			if (value) {
				root.style.setProperty(prop, value);
			}
		}
	}

	// Get the window ID for view management IPC
	const windowId = (configuration.windowId as number) ?? -1;

	// Send the full native window configuration to the main process
	// so the ShellViewManager can clone it for embedded workbench views
	ipcRenderer.invoke('vscode:shellView-setBaseConfig', configuration);

	const contentArea = document.getElementById('iframe-container')!;
	const backend = createElectronBackend(windowId, ipcRenderer, contentArea);
	new ShellApplication(backend);

	// Use ResizeObserver to keep the WebContentsView layout in sync
	const resizeObserver = new ResizeObserver(() => {
		const rect = contentArea.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			ipcRenderer.invoke('vscode:shellView-layoutActiveView', windowId, rect.x, rect.y, rect.width, rect.height);
		}
	});
	resizeObserver.observe(contentArea);
})();
