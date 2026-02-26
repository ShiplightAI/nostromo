/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalInputNotificationSettingId } from '../common/terminalInputNotificationConfiguration.js';
import { IShellNotificationService } from '../../../../services/shell/browser/shellNotificationService.js';

/**
 * Detects when a terminal in a background workbench has new output followed
 * by silence, and sends a notification to the shell sidebar so a bell badge
 * is shown next to the worktree entry.
 *
 * Rules:
 * 1. Foreground/background status is tracked via shell.activeView messages
 *    (web) and vscode:shellActiveView IPC (Electron).
 * 2. A foreground workbench never sends notifications and clears any active one.
 * 3. After going background, exactly one notification is allowed, triggered by
 *    new terminal output followed by silence (no output for N seconds).
 */
class TerminalInputNotificationContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.inputNotification';

	static get(instance: ITerminalInstance): TerminalInputNotificationContribution | null {
		return instance.getContribution<TerminalInputNotificationContribution>(TerminalInputNotificationContribution.ID);
	}

	private _isBackground = false;
	private _hasNewOutput = false; // new terminal output since going background
	private _notified = false; // already sent one notification since going background
	private _silenceTimer: ReturnType<typeof setTimeout> | undefined;
	private _notificationActive = false;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IShellNotificationService private readonly _shellNotificationService: IShellNotificationService,
	) {
		super();
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		// Detect substantial output: line feeds indicate real content being
		// written (not just mode toggles like CSI ?2026h/l).
		this._register(xterm.raw.onLineFeed(() => {
			this._onTerminalOutput();
		}));

		// Title changes also indicate output activity.
		this._register(xterm.raw.onTitleChange(() => {
			this._onTerminalOutput();
		}));

		// User input — clear any active notification since the user is
		// interacting with this terminal directly.
		this._register(xterm.raw.onData(() => {
			this._clearSilenceTimer();
			this._clearNotification();
		}));

		// Foreground/background tracking.
		const onActivated = () => {
			console.log('[InputNotification] workbench activated');
			this._isBackground = false;
			this._hasNewOutput = false;
			this._notified = false;
			this._clearSilenceTimer();
			this._clearNotification();
		};
		const onDeactivated = () => {
			console.log('[InputNotification] workbench deactivated');
			this._isBackground = true;
			this._hasNewOutput = false;
			this._notified = false;
		};

		// Electron: focus event fires when WebContentsView gains focus.
		mainWindow.addEventListener('focus', onActivated);

		// Web shell: parent posts shell.activeView messages when switching iframes.
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === 'shell.activeView') {
				console.log('[InputNotification] shell.activeView message, active:', e.data.active);
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
			console.log('[InputNotification] IPC shellActiveView, active:', active);
			if (active) {
				onActivated();
			} else {
				onDeactivated();
			}
		};
		vscodeGlobal?.ipcRenderer?.on('vscode:shellActiveView', onIpcActiveView);

		this._register({
			dispose: () => {
				mainWindow.removeEventListener('focus', onActivated);
				mainWindow.removeEventListener('message', onMessage);
				vscodeGlobal?.ipcRenderer?.removeListener('vscode:shellActiveView', onIpcActiveView);
			}
		});
	}

	private _onTerminalOutput(): void {
		if (!this._isBackground) {
			return;
		}
		this._hasNewOutput = true;
		// New output while in background — reset the silence timer.
		// Clear any active notification since more output is coming.
		this._clearNotification();
		this._resetSilenceTimer();
	}

	private _resetSilenceTimer(): void {
		this._clearSilenceTimer();
		if (!this._isEnabled() || !this._isBackground || !this._hasNewOutput || this._notified) {
			return;
		}
		const silenceMs = this._configurationService.getValue<number>(TerminalInputNotificationSettingId.InputNotificationSilenceMs) ?? 5000;
		this._silenceTimer = setTimeout(() => {
			this._onSilenceDetected();
		}, silenceMs);
	}

	private _clearSilenceTimer(): void {
		if (this._silenceTimer !== undefined) {
			clearTimeout(this._silenceTimer);
			this._silenceTimer = undefined;
		}
	}

	private _onSilenceDetected(): void {
		console.log('[InputNotification] silence detected — background:', this._isBackground,
			'hasNewOutput:', this._hasNewOutput, 'notified:', this._notified);

		if (!this._isEnabled() || !this._isBackground || !this._hasNewOutput || this._notified) {
			return;
		}

		console.log('[InputNotification] sending notification');
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
		this._clearSilenceTimer();
		this._clearNotification();
		super.dispose();
	}
}

registerTerminalContribution(TerminalInputNotificationContribution.ID, TerminalInputNotificationContribution);
