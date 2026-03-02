/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import type { ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalInputNotificationSettingId } from '../common/terminalInputNotificationConfiguration.js';
import { IShellNotificationService } from '../../../../services/shell/browser/shellNotificationService.js';

/**
 * Detects when a command finishes in a background workbench terminal and
 * sends a notification to the shell sidebar so a bell badge is shown next
 * to the worktree entry — indicating the terminal is waiting for user input.
 *
 * Rules:
 * 1. Foreground/background status is tracked via shell.activeView messages
 *    (web) and vscode:shellActiveView IPC (Electron).
 * 2. A foreground workbench never sends notifications.
 * 3. Notifications fire when a command completes in the background, meaning
 *    the terminal is now at the shell prompt waiting for user input.
 * 4. Notifications are only dismissed when the user switches to the worktree.
 */
class TerminalInputNotificationContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.inputNotification';

	static get(instance: ITerminalInstance): TerminalInputNotificationContribution | null {
		return instance.getContribution<TerminalInputNotificationContribution>(TerminalInputNotificationContribution.ID);
	}

	private _isBackground = false;
	private _notified = false; // already sent one notification since going background
	private _notificationActive = false;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IShellNotificationService private readonly _shellNotificationService: IShellNotificationService,
	) {
		super();
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		// User input — clear any active notification since the user is
		// interacting with this terminal directly.
		this._register(xterm.raw.onData(() => {
			this._clearNotification();
		}));

		// Listen for command completion via shell integration.
		const instance = this._ctx.instance;
		this._register(instance.capabilities.onDidAddCapability(e => {
			if (e.id === TerminalCapability.CommandDetection) {
				const cmdDetection = instance.capabilities.get(TerminalCapability.CommandDetection)!;
				this._register(cmdDetection.onCommandFinished(() => {
					this._onCommandFinished();
				}));
			}
		}));

		// If command detection is already available, register immediately.
		const cmdDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdDetection) {
			this._register(cmdDetection.onCommandFinished(() => {
				this._onCommandFinished();
			}));
		}

		// Foreground/background tracking.
		const onActivated = () => {
			this._isBackground = false;
			this._notified = false;
			// Do NOT clear notification here — the shell dismisses the badge
			// only when the user switches to this worktree via switchToWorktree().
		};
		const onDeactivated = () => {
			this._isBackground = true;
			this._notified = false;
		};

		// Web shell: parent posts shell.activeView messages when switching iframes.
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === 'shell.activeView') {
				if (e.data.active) {
					onActivated();
				} else {
					onDeactivated();
				}
			}
		};
		mainWindow.addEventListener('message', onMessage);

		// Electron shell: main process sends IPC when switching WebContentsViews.
		const vscodeGlobal = (mainWindow as unknown as { vscode?: { ipcRenderer?: { on(channel: string, listener: (...args: unknown[]) => void): void; removeListener(channel: string, listener: (...args: unknown[]) => void): void } } }).vscode;
		const onIpcActiveView = (_event: unknown, active: unknown) => {
			if (active) {
				onActivated();
			} else {
				onDeactivated();
			}
		};
		vscodeGlobal?.ipcRenderer?.on('vscode:shellActiveView', onIpcActiveView);

		this._register({
			dispose: () => {
				mainWindow.removeEventListener('message', onMessage);
				vscodeGlobal?.ipcRenderer?.removeListener('vscode:shellActiveView', onIpcActiveView);
			}
		});
	}

	private _onCommandFinished(): void {
		if (!this._isEnabled() || !this._isBackground || this._notified) {
			return;
		}

		this._notified = true;
		this._notificationActive = true;
		this._shellNotificationService.notify({
			type: 'terminalInputWaiting',
			source: TerminalInputNotificationContribution.ID,
			active: true,
			severity: 'warning',
			message: `Terminal: ${this._ctx.instance.title || 'Terminal'} — Needs attention`,
		});
	}

	private _clearNotification(): void {
		if (!this._notificationActive) {
			return;
		}
		this._notificationActive = false;
		this._shellNotificationService.clear(TerminalInputNotificationContribution.ID);
	}

	private _isEnabled(): boolean {
		return this._configurationService.getValue<boolean>(TerminalInputNotificationSettingId.EnableInputNotification) === true;
	}

	override dispose(): void {
		this._clearNotification();
		super.dispose();
	}
}

registerTerminalContribution(TerminalInputNotificationContribution.ID, TerminalInputNotificationContribution);
