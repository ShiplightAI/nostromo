/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from '../../../base/common/path.js';
import { homedir } from 'os';
import { BrowserWindow, dialog } from 'electron';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { Disposable } from '../../../base/common/lifecycle.js';

export interface IWorktreeInfo {
	path: string;
	head: string;
	branch: string;
	isBare: boolean;
}

export interface IRepoWorktreeResult {
	repoUri: string;
	worktrees: IWorktreeInfo[];
	error?: string;
}

export interface IBrowseResult {
	path: string;
	entries: { name: string; isDirectory: boolean }[];
	parent: string | null;
}

export interface IShellSettings {
	trackedRepositories: string[];
	lastBrowsePath: string;
}

const SHELL_SETTINGS_FILE = 'shellSettings.json';

/**
 * Shell worktree service running in the main process.
 * Handles file browsing and git worktree operations via IPC,
 * replacing the HTTP API endpoints used in the web version.
 */
export class ShellWorktreeService extends Disposable {

	private readonly _settingsPath: string;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService
	) {
		super();
		this._settingsPath = join(this.environmentMainService.appSettingsHome.fsPath, SHELL_SETTINGS_FILE);
		this._registerIpcHandlers();
	}

	private _registerIpcHandlers(): void {
		validatedIpcMain.handle('vscode:shellWorktree-listDirectory', (_event, path: string, showHidden: boolean) => {
			return this.listDirectory(path, showHidden);
		});

		validatedIpcMain.handle('vscode:shellWorktree-getWorktrees', (_event, repoUris: string[]) => {
			return this.getWorktrees(repoUris);
		});

		validatedIpcMain.handle('vscode:shellWorktree-addWorktree', (_event, repoPath: string, branchName: string, newBranch: boolean) => {
			return this.addWorktree(repoPath, branchName, newBranch);
		});

		validatedIpcMain.handle('vscode:shellWorktree-removeWorktree', (_event, repoPath: string, worktreePath: string) => {
			return this.removeWorktree(repoPath, worktreePath);
		});

		validatedIpcMain.handle('vscode:shellWorktree-listBranches', (_event, repoPath: string) => {
			return this.listBranches(repoPath);
		});

		validatedIpcMain.handle('vscode:shellWorktree-cloneRepo', (_event, url: string, destPath: string) => {
			return this.cloneRepo(url, destPath);
		});

		validatedIpcMain.handle('vscode:shellWorktree-loadSettings', () => {
			return this.loadSettings();
		});

		validatedIpcMain.handle('vscode:shellWorktree-saveSettings', (_event, settings: IShellSettings) => {
			return this.saveSettings(settings);
		});

		validatedIpcMain.handle('vscode:shellWorktree-showOpenDialog', async (_event) => {
			const parentWindow = BrowserWindow.fromWebContents(_event.sender);
			const result = await dialog.showOpenDialog(parentWindow ?? BrowserWindow.getFocusedWindow()!, {
				properties: ['openDirectory'],
				title: 'Select Folder'
			});
			if (result.canceled || result.filePaths.length === 0) {
				return null;
			}
			return result.filePaths[0];
		});
	}

	async loadSettings(): Promise<IShellSettings> {
		try {
			const data = await fs.readFile(this._settingsPath, 'utf-8');
			return JSON.parse(data);
		} catch {
			return { trackedRepositories: [], lastBrowsePath: '' };
		}
	}

	async saveSettings(settings: IShellSettings): Promise<void> {
		try {
			const dir = dirname(this._settingsPath);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(this._settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
		} catch (err) {
			this.logService.error('[ShellWorktreeService] Failed to save settings:', err);
		}
	}

	async listDirectory(path: string, showHidden: boolean): Promise<IBrowseResult> {
		const browsePath = path || homedir();
		const resolvedPath = resolve(browsePath);

		const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
		const dirs = entries
			.filter(e => e.isDirectory() && (showHidden || !e.name.startsWith('.')))
			.map(e => ({ name: e.name, isDirectory: true }))
			.sort((a, b) => a.name.localeCompare(b.name));

		const parent = dirname(resolvedPath) !== resolvedPath ? dirname(resolvedPath) : null;

		return { path: resolvedPath, entries: dirs, parent };
	}

	async getWorktrees(repoUris: string[]): Promise<IRepoWorktreeResult[]> {
		const results: IRepoWorktreeResult[] = [];

		for (const repoUri of repoUris) {
			const repoPath = URI.parse(repoUri).fsPath;
			try {
				const stdout = await this._execGit(['worktree', 'list', '--porcelain'], repoPath);

				const worktrees: IWorktreeInfo[] = [];
				const blocks = stdout.split('\n\n').filter(b => b.trim());
				for (const block of blocks) {
					const lines = block.split('\n');
					let wtPath = '';
					let head = '';
					let branch = '';
					let isBare = false;
					for (const line of lines) {
						if (line.startsWith('worktree ')) {
							wtPath = line.substring('worktree '.length);
						} else if (line.startsWith('HEAD ')) {
							head = line.substring('HEAD '.length);
						} else if (line.startsWith('branch ')) {
							branch = line.substring('branch '.length);
						} else if (line === 'bare') {
							isBare = true;
						}
					}
					if (wtPath) {
						worktrees.push({ path: wtPath, head, branch, isBare });
					}
				}

				results.push({ repoUri, worktrees });
			} catch (err) {
				results.push({ repoUri, worktrees: [], error: String(err) });
			}
		}

		return results;
	}

	async addWorktree(repoPath: string, branchName: string, newBranch: boolean): Promise<{ success: boolean; path?: string; error?: string }> {
		const sanitized = branchName.replace(/\//g, '-');
		const worktreePath = `${repoPath}-${sanitized}`;

		try {
			const args = newBranch
				? ['worktree', 'add', '-b', branchName, worktreePath]
				: ['worktree', 'add', worktreePath, branchName];

			await this._execGit(args, repoPath);
			return { success: true, path: worktreePath };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async removeWorktree(repoPath: string, worktreePath: string): Promise<{ success: boolean; error?: string }> {
		try {
			await this._execGit(['worktree', 'remove', '--force', worktreePath], repoPath);
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async listBranches(repoPath: string): Promise<{ branches: string[] }> {
		try {
			const stdout = await this._execGit(['branch', '-a', '--no-color'], repoPath);

			const branches = stdout
				.split('\n')
				.map(line => line.replace(/^[*+]?\s+/, '').trim())
				.filter(line => line && !line.includes(' -> '))
				.map(line => line.replace(/^remotes\/origin\//, ''));
			const unique = [...new Set(branches)];

			return { branches: unique };
		} catch (err) {
			return { branches: [] };
		}
	}

	async cloneRepo(url: string, destPath: string): Promise<{ success: boolean; path?: string; error?: string }> {
		try {
			await this._execGit(['clone', url, destPath], undefined, 120000);
			return { success: true, path: destPath };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	private _execGit(args: string[], cwd: string | undefined, timeout = 30000): Promise<string> {
		return new Promise<string>((resolveExec, rejectExec) => {
			execFile('git', args, { cwd, timeout }, (err, stdout) => {
				if (err) {
					this.logService.error(`[ShellWorktreeService] git ${args.join(' ')} failed:`, err);
					rejectExec(err);
				} else {
					resolveExec(stdout);
				}
			});
		});
	}

	override dispose(): void {
		validatedIpcMain.removeHandler('vscode:shellWorktree-listDirectory');
		validatedIpcMain.removeHandler('vscode:shellWorktree-getWorktrees');
		validatedIpcMain.removeHandler('vscode:shellWorktree-addWorktree');
		validatedIpcMain.removeHandler('vscode:shellWorktree-removeWorktree');
		validatedIpcMain.removeHandler('vscode:shellWorktree-listBranches');
		validatedIpcMain.removeHandler('vscode:shellWorktree-cloneRepo');
		validatedIpcMain.removeHandler('vscode:shellWorktree-loadSettings');
		validatedIpcMain.removeHandler('vscode:shellWorktree-saveSettings');
		validatedIpcMain.removeHandler('vscode:shellWorktree-showOpenDialog');
		super.dispose();
	}
}
