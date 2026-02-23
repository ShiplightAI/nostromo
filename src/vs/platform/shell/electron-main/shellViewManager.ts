/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebContentsView } from 'electron';
import { createHash } from 'crypto';
import { FileAccess } from '../../../base/common/network.js';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IProtocolMainService } from '../../protocol/electron-main/protocol.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { getAllWindowsExcludingOffscreen } from '../../windows/electron-main/windows.js';
import { INativeWindowConfiguration } from '../../window/common/window.js';
import { URI } from '../../../base/common/uri.js';

interface IManagedView {
	view: WebContentsView;
	folderPath: string;
	configDisposable: { dispose(): void };
}

/**
 * Manages WebContentsView instances embedded in shell BrowserWindows.
 * Each view hosts a full VS Code workbench for a specific worktree folder.
 * Hidden views keep their processes alive so agents continue running.
 */
export class ShellViewManager extends Disposable {

	private readonly views = new Map<string, IManagedView>(); // key: `${windowId}:${folderPath}`
	private readonly activeViews = new Map<number, string>(); // windowId -> active folderPath
	private baseConfig: INativeWindowConfiguration | undefined;

	constructor(
		@IProtocolMainService private readonly protocolMainService: IProtocolMainService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		this._registerIpcHandlers();
	}

	private _registerIpcHandlers(): void {
		validatedIpcMain.handle('vscode:shellView-setBaseConfig', async (_event, config: INativeWindowConfiguration) => {
			this.baseConfig = config;
		});

		validatedIpcMain.handle('vscode:shellView-activateWorktree', (_event, windowId: number, folderPath: string) => {
			return this.activateWorktree(windowId, folderPath);
		});

		validatedIpcMain.handle('vscode:shellView-layoutActiveView', async (_event, windowId: number, x: number, y: number, width: number, height: number) => {
			this.layoutActiveView(windowId, x, y, width, height);
		});

		validatedIpcMain.handle('vscode:shellView-removeView', async (_event, windowId: number, folderPath: string) => {
			this.removeView(windowId, folderPath);
		});
	}

	async activateWorktree(windowId: number, folderPath: string): Promise<void> {
		const parentWindow = this._getWindow(windowId);
		if (!parentWindow) {
			this.logService.warn(`[ShellViewManager] Window ${windowId} not found`);
			return;
		}

		// Hide all views for this window
		for (const [key, managed] of this.views) {
			if (key.startsWith(`${windowId}:`)) {
				managed.view.setVisible(false);
			}
		}

		const viewKey = `${windowId}:${folderPath}`;
		let managed = this.views.get(viewKey);

		if (!managed) {
			managed = this._createView(windowId, folderPath, parentWindow);
			this.views.set(viewKey, managed);
		}

		managed.view.setVisible(true);
		this.activeViews.set(windowId, folderPath);

		this.logService.trace(`[ShellViewManager] Activated worktree view for ${folderPath} in window ${windowId}`);
	}

	layoutActiveView(windowId: number, x: number, y: number, width: number, height: number): void {
		const activePath = this.activeViews.get(windowId);
		if (!activePath) {
			return;
		}

		const viewKey = `${windowId}:${activePath}`;
		const managed = this.views.get(viewKey);
		if (managed) {
			managed.view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
		}
	}

	removeView(windowId: number, folderPath: string): void {
		const viewKey = `${windowId}:${folderPath}`;
		const managed = this.views.get(viewKey);
		if (!managed) {
			return;
		}

		const parentWindow = this._getWindow(windowId);
		if (parentWindow) {
			parentWindow.contentView.removeChildView(managed.view);
		}

		managed.view.webContents.close({ waitForBeforeUnload: false });
		managed.configDisposable.dispose();
		this.views.delete(viewKey);

		if (this.activeViews.get(windowId) === folderPath) {
			this.activeViews.delete(windowId);
		}

		this.logService.trace(`[ShellViewManager] Removed view for ${folderPath} from window ${windowId}`);
	}

	private _createView(windowId: number, folderPath: string, parentWindow: Electron.BrowserWindow): IManagedView {
		// Create config object URL (same pattern as CodeWindow)
		const configObjectUrl = this.protocolMainService.createIPCObjectUrl<INativeWindowConfiguration>();

		// Build a full INativeWindowConfiguration by cloning the shell window's config
		// and replacing the workspace with the target folder
		const folderUri = URI.file(folderPath);
		const folderId = createHash('md5').update(folderUri.toString()).digest('hex');
		const workspaceIdentifier = { id: folderId, uri: folderUri };

		if (this.baseConfig) {
			const viewConfig: INativeWindowConfiguration = {
				...this.baseConfig,
				windowId: -1,
				workspace: workspaceIdentifier,
				isShellWindow: false,
				// Clear file-open params from base config
				filesToOpenOrCreate: undefined,
				filesToDiff: undefined,
				filesToMerge: undefined,
				filesToWait: undefined,
				// Clear backup path (each view gets its own)
				backupPath: undefined,
			};
			configObjectUrl.update(viewConfig);
		} else {
			this.logService.warn('[ShellViewManager] No base config available, view may fail to load');
		}

		const view = new WebContentsView({
			webPreferences: {
				preload: FileAccess.asFileUri('vs/base/parts/sandbox/electron-browser/preload.js').fsPath,
				additionalArguments: [`--vscode-window-config=${configObjectUrl.resource.toString()}`],
				sandbox: true,
				enableWebSQL: false,
				spellcheck: false,
				enableBlinkFeatures: 'HighlightAPI',
				v8CacheOptions: this.environmentMainService.useCodeCache ? 'bypassHeatCheck' : 'none',
			}
		});

		// Load the workbench HTML (same URL as normal windows)
		const workbenchUrl = FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true);
		view.webContents.loadURL(workbenchUrl);

		// Add to parent window
		parentWindow.contentView.addChildView(view);

		this.logService.trace(`[ShellViewManager] Created WebContentsView for ${folderPath}`);

		return {
			view,
			folderPath,
			configDisposable: configObjectUrl
		};
	}

	private _getWindow(windowId: number): Electron.BrowserWindow | undefined {
		return getAllWindowsExcludingOffscreen().find(w => w.id === windowId);
	}

	override dispose(): void {
		for (const [key, managed] of this.views) {
			const windowId = parseInt(key.split(':')[0], 10);
			const parentWindow = this._getWindow(windowId);
			if (parentWindow) {
				parentWindow.contentView.removeChildView(managed.view);
			}
			managed.view.webContents.close({ waitForBeforeUnload: false });
			managed.configDisposable.dispose();
		}
		this.views.clear();
		this.activeViews.clear();

		validatedIpcMain.removeHandler('vscode:shellView-setBaseConfig');
		validatedIpcMain.removeHandler('vscode:shellView-activateWorktree');
		validatedIpcMain.removeHandler('vscode:shellView-layoutActiveView');
		validatedIpcMain.removeHandler('vscode:shellView-removeView');
		super.dispose();
	}
}
