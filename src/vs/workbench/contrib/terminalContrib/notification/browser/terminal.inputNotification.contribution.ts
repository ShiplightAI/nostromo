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
 * Detects when a terminal process appears to be waiting for user input
 * (based on bracketed paste mode being active + output silence) and
 * sends a notification to the shell sidebar so a badge is shown
 * next to the worktree entry.
 *
 * This is useful when running CLI agents (e.g. claude, codex) across
 * multiple worktrees — only one worktree is visible at a time, and this
 * helps the user know which worktree needs attention.
 */
class TerminalInputNotificationContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.inputNotification';

	static get(instance: ITerminalInstance): TerminalInputNotificationContribution | null {
		return instance.getContribution<TerminalInputNotificationContribution>(TerminalInputNotificationContribution.ID);
	}

	private _bracketedPasteMode = false;
	private _silenceTimer: ReturnType<typeof setTimeout> | undefined;
	private _notificationActive = false;
	private _acknowledged = false;

	constructor(
		private readonly _ctx: ITerminalContributionContext,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IShellNotificationService private readonly _shellNotificationService: IShellNotificationService,
	) {
		super();
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		// Track bracketed paste mode transitions via CSI handler.
		// CSI ? 2004 h = enable, CSI ? 2004 l = disable.
		this._register(xterm.raw.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
			for (let i = 0; i < params.length; i++) {
				if (params[i] === 2004) {
					this._onBracketedPasteModeChanged(true);
				}
			}
			return false; // don't consume — let xterm handle normally
		}));

		this._register(xterm.raw.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
			for (let i = 0; i < params.length; i++) {
				if (params[i] === 2004) {
					this._onBracketedPasteModeChanged(false);
				}
			}
			return false;
		}));

		// Detect substantial output: cursor moves to new lines indicate real
		// content being written, not just mode toggles like CSI ?2026h/l
		// (synchronized output mode) which some CLIs emit periodically while idle.
		this._register(xterm.raw.onLineFeed(() => {
			this._onSubstantialOutput();
		}));

		// Title changes also indicate output activity
		this._register(xterm.raw.onTitleChange(() => {
			this._onSubstantialOutput();
		}));

		// User input resets everything — they're actively interacting
		this._register(xterm.raw.onData(() => {
			this._acknowledged = false;
			this._clearSilenceTimer();
			this._clearNotification();
		}));

		// When this workbench becomes the active view, acknowledge the
		// current notification so the silence timer doesn't re-fire while
		// the terminal is still idle at the same prompt.
		//
		// Detection mechanisms:
		// - `focus` event: works in Electron WebContentsView
		// - `shell.activeView` postMessage: works in iframe-based shell
		//   where CSS visibility:hidden doesn't trigger visibilitychange
		//   or focus events on the iframe's document.
		const onActivated = () => {
			console.log('[InputNotification] workbench activated — acknowledging');
			this._acknowledged = true;
			this._clearSilenceTimer();
			this._clearNotification();
		};
		const onDeactivated = () => {
			console.log('[InputNotification] workbench deactivated');
			// Don't reset _acknowledged here — that only happens on new
			// prompt cycles (BPM OFF→ON) or user input.
		};

		// Electron: focus event fires when WebContentsView gains focus
		mainWindow.addEventListener('focus', onActivated);

		// Web shell: parent posts shell.activeView messages when switching iframes
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

		this._register({
			dispose: () => {
				mainWindow.removeEventListener('focus', onActivated);
				mainWindow.removeEventListener('message', onMessage);
			}
		});
	}

	private _onBracketedPasteModeChanged(enabled: boolean): void {
		const wasEnabled = this._bracketedPasteMode;
		this._bracketedPasteMode = enabled;
		if (enabled) {
			// Only reset acknowledged on a genuine OFF→ON transition, meaning
			// the agent ran (turned BPM off) and a new prompt appeared (turned
			// BPM back on). A duplicate ON while already ON is not a new cycle.
			if (!wasEnabled) {
				this._acknowledged = false;
			}
			this._resetSilenceTimer();
		} else {
			// Bracketed paste mode turned off — process is likely executing.
			this._clearSilenceTimer();
			this._clearNotification();
		}
	}

	private _onSubstantialOutput(): void {
		if (!this._bracketedPasteMode) {
			return;
		}
		// Real output (line feeds, title changes) means the process is still
		// producing output. Reset the silence timer.
		this._resetSilenceTimer();
		// Clear any active notification since the process is outputting
		this._clearNotification();
	}

	private _resetSilenceTimer(): void {
		this._clearSilenceTimer();
		if (!this._isEnabled() || this._acknowledged) {
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
		console.log('[InputNotification] silence detected — bpm:', this._bracketedPasteMode,
			'enabled:', this._isEnabled(), 'hasFocus:', mainWindow.document.hasFocus(),
			'acknowledged:', this._acknowledged, 'active:', this._notificationActive);

		if (!this._bracketedPasteMode || !this._isEnabled()) {
			return;
		}

		// Don't notify if the window is in the foreground — the user can
		// already see this workbench, so a badge would be redundant.
		if (mainWindow.document.hasFocus()) {
			return;
		}

		if (this._acknowledged || this._notificationActive) {
			return;
		}

		console.log('[InputNotification] sending notification');
		this._notificationActive = true;
		this._shellNotificationService.notify({
			type: 'terminalInputWaiting',
			source: TerminalInputNotificationContribution.ID,
			active: true,
			severity: 'warning',
			message: `Terminal: ${this._ctx.instance.title || 'Terminal'} — Waiting for your input`,
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
