/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { AgentSessionProviders } from './agentSessions/agentSessions.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IAction } from '../../../../base/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';

type AgentTabKind = 'terminal' | 'copilot';

interface IAgentTab {
	readonly id: string;
	name: string;
	readonly kind: AgentTabKind;
	readonly command?: string;
	readonly terminalInstance?: ITerminalInstance;
	readonly tabElement: HTMLElement;
	readonly labelElement: HTMLElement;
	readonly contentContainer: HTMLElement;
}

const TAB_BAR_HEIGHT = 30;

export class AgentTerminalViewPane extends ViewPane {

	private _tabs: IAgentTab[] = [];
	private _activeTabId: string | undefined;
	private _tabDisposables = this._register(new DisposableMap<string>());
	private _tabBar: HTMLElement | undefined;
	private _addButton: HTMLElement | undefined;
	private _terminalContainer: HTMLElement | undefined;
	private _bodyContainer: HTMLElement | undefined;
	private _nextTabId = 0;
	private _bodyDimension: { width: number; height: number } | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ICommandService private readonly _commandService: ICommandService,
		@IPreferencesService private readonly _preferencesService: IPreferencesService,
	) {
		super(options, keybindingService, _contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && this._tabs.length === 0) {
				this._addTerminalTab('claude', 'Claude');
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		this._bodyContainer = append(container, $('.agent-terminal-body'));
		this._bodyContainer.style.display = 'flex';
		this._bodyContainer.style.flexDirection = 'column';
		this._bodyContainer.style.width = '100%';
		this._bodyContainer.style.height = '100%';

		// Tab bar
		this._tabBar = append(this._bodyContainer, $('.agent-terminal-tab-bar'));

		// "+" button
		this._addButton = append(this._tabBar, $('.agent-terminal-tab-add'));
		const addButton = this._addButton;
		const addIcon = append(addButton, $(ThemeIcon.asCSSSelector(Codicon.plus)));
		addIcon.style.pointerEvents = 'none';
		this._register(addDisposableListener(addButton, EventType.CLICK, e => {
			e.stopPropagation();
			this._showAddTabMenu(addButton);
		}));

		// Spacer pushes gear to the right
		append(this._tabBar, $('.agent-terminal-tab-spacer'));

		// Gear icon
		const gearButton = append(this._tabBar, $('.agent-terminal-tab-gear'));
		const gearIcon = append(gearButton, $(ThemeIcon.asCSSSelector(Codicon.settingsGear)));
		gearIcon.style.pointerEvents = 'none';
		this._register(addDisposableListener(gearButton, EventType.CLICK, () => {
			this._preferencesService.openSettings({ query: 'chat.agents' });
		}));

		// Terminal content area
		this._terminalContainer = append(this._bodyContainer, $('.agent-terminal-content'));
	}

	private _getTerminalAgentOptions(): { command: string; name: string; provider: string }[] {
		const config = this.configurationService;
		return [
			{ command: config.getValue<string>('chat.agents.claude.command') || 'claude', name: 'Claude', provider: AgentSessionProviders.Claude },
			{ command: config.getValue<string>('chat.agents.codex.command') || 'codex', name: 'Codex', provider: AgentSessionProviders.Codex },
			{ command: config.getValue<string>('chat.agents.copilotCli.command') || 'gh copilot', name: 'Copilot CLI', provider: AgentSessionProviders.Background },
		];
	}

	private _showAddTabMenu(anchor: HTMLElement): void {
		const copilotAction: IAction = {
			id: 'addAgent.copilot',
			label: 'GitHub Copilot',
			tooltip: '',
			class: undefined,
			enabled: !this._tabs.some(t => t.kind === 'copilot'),
			run: () => this._addCopilotTab(),
		};

		const terminalAgents = this._getTerminalAgentOptions();
		const terminalActions: IAction[] = terminalAgents.map(agent => ({
			id: `addAgent.${agent.provider}`,
			label: agent.name,
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => this._addTerminalTab(agent.command, agent.name),
		}));

		this._contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [...terminalActions, copilotAction],
		});
	}

	private _addCopilotTab(): void {
		if (!this._tabBar || !this._terminalContainer) {
			return;
		}

		// Only allow one copilot tab
		if (this._tabs.some(t => t.kind === 'copilot')) {
			const existing = this._tabs.find(t => t.kind === 'copilot');
			if (existing) {
				this._activateTab(existing.id);
			}
			return;
		}

		const id = `tab-${this._nextTabId++}`;
		const store = new DisposableStore();

		// Create tab element (insert before the "+" button)
		const tabElement = document.createElement('div');
		tabElement.className = 'agent-terminal-tab';
		tabElement.dataset.tabId = id;
		this._tabBar.insertBefore(tabElement, addButton ?? null);

		// Label
		const labelElement = append(tabElement, $('span.tab-label'));
		labelElement.textContent = 'GitHub Copilot';

		// No close button for copilot tab

		// Content container with placeholder
		const contentContainer = append(this._terminalContainer, $('.agent-copilot-placeholder'));
		const titleEl = append(contentContainer, $('div.title'));
		titleEl.textContent = 'GitHub Copilot Chat';
		const descEl = append(contentContainer, $('div.description'));
		descEl.textContent = 'Use the built-in Copilot chat for AI-powered assistance.';
		const button = append(contentContainer, $('button.open-chat-button'));
		button.textContent = 'Open Chat';

		store.add(addDisposableListener(button, EventType.CLICK, () => {
			this._commandService.executeCommand('workbench.action.chat.open');
		}));

		const tab: IAgentTab = {
			id,
			name: 'GitHub Copilot',
			kind: 'copilot',
			tabElement,
			labelElement,
			contentContainer,
		};
		this._tabs.push(tab);

		// Click to activate
		store.add(addDisposableListener(tabElement, EventType.CLICK, () => {
			this._activateTab(id);
		}));

		this._tabDisposables.set(id, store);
		this._activateTab(id);
	}

	private async _addTerminalTab(command: string, name: string): Promise<void> {
		if (!this._tabBar || !this._terminalContainer) {
			return;
		}

		const id = `tab-${this._nextTabId++}`;
		const store = new DisposableStore();

		// Create tab element (insert before the "+" button)
		const tabElement = document.createElement('div');
		tabElement.className = 'agent-terminal-tab';
		tabElement.dataset.tabId = id;
		this._tabBar.insertBefore(tabElement, addButton ?? null);

		// Label
		const labelElement = append(tabElement, $('span.tab-label'));
		labelElement.textContent = name;

		// Close button
		const closeButton = append(tabElement, $('span.close-button'));
		const closeIcon = append(closeButton, $(ThemeIcon.asCSSSelector(Codicon.close)));
		closeIcon.style.pointerEvents = 'none';

		// Per-tab terminal container
		const contentContainer = append(this._terminalContainer, $('.agent-terminal-instance.terminal-overflow-guard'));

		// Create terminal
		let terminalInstance: ITerminalInstance;
		try {
			terminalInstance = await this._terminalService.createTerminal({
				config: {
					name,
					isFeatureTerminal: true,
					hideFromUser: true,
				},
				location: TerminalLocation.Editor,
			});

			await terminalInstance.xtermReadyPromise;
			terminalInstance.attachToElement(contentContainer);

			// Send the agent command
			terminalInstance.sendText(command, true);
		} catch (err) {
			tabElement.remove();
			contentContainer.remove();
			store.dispose();
			return;
		}

		const tab: IAgentTab = {
			id,
			name,
			kind: 'terminal',
			command,
			terminalInstance,
			tabElement,
			labelElement,
			contentContainer,
		};
		this._tabs.push(tab);

		// Click to activate
		store.add(addDisposableListener(tabElement, EventType.CLICK, e => {
			if (!(e.target as HTMLElement).classList.contains('close-button') &&
				!(e.target as HTMLElement).closest('.close-button')) {
				this._activateTab(id);
			}
		}));

		// Double-click to rename
		store.add(addDisposableListener(labelElement, EventType.DBLCLICK, e => {
			e.stopPropagation();
			this._startRename(tab);
		}));

		// Close button
		store.add(addDisposableListener(closeButton, EventType.CLICK, e => {
			e.stopPropagation();
			this._closeTab(id);
		}));

		// Terminal disposed externally
		store.add(terminalInstance.onDisposed(() => {
			this._removeTabFromList(id);
		}));

		this._tabDisposables.set(id, store);
		this._activateTab(id);
	}

	private _activateTab(tabId: string): void {
		this._activeTabId = tabId;

		for (const tab of this._tabs) {
			const isActive = tab.id === tabId;
			tab.tabElement.classList.toggle('active', isActive);
			tab.contentContainer.style.display = isActive ? '' : 'none';

			if (tab.kind === 'terminal' && tab.terminalInstance) {
				tab.terminalInstance.setVisible(isActive);

				if (isActive && this._bodyDimension) {
					const termHeight = this._bodyDimension.height - TAB_BAR_HEIGHT;
					tab.terminalInstance.layout({
						width: this._bodyDimension.width,
						height: Math.max(0, termHeight),
					});
				}
			}
		}
	}

	private _closeTab(tabId: string): void {
		const idx = this._tabs.findIndex(t => t.id === tabId);
		if (idx === -1) {
			return;
		}

		const tab = this._tabs[idx];
		if (tab.kind === 'terminal' && tab.terminalInstance) {
			tab.terminalInstance.dispose();
		}
		tab.tabElement.remove();
		tab.contentContainer.remove();
		this._tabDisposables.deleteAndDispose(tabId);
		this._tabs.splice(idx, 1);

		// Activate neighbor
		if (this._activeTabId === tabId && this._tabs.length > 0) {
			const newIdx = Math.min(idx, this._tabs.length - 1);
			this._activateTab(this._tabs[newIdx].id);
		}
	}

	private _removeTabFromList(tabId: string): void {
		const idx = this._tabs.findIndex(t => t.id === tabId);
		if (idx === -1) {
			return;
		}

		const tab = this._tabs[idx];
		tab.tabElement.remove();
		tab.contentContainer.remove();
		this._tabDisposables.deleteAndDispose(tabId);
		this._tabs.splice(idx, 1);

		if (this._activeTabId === tabId && this._tabs.length > 0) {
			const newIdx = Math.min(idx, this._tabs.length - 1);
			this._activateTab(this._tabs[newIdx].id);
		}
	}

	private _startRename(tab: IAgentTab): void {
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'tab-label-input';
		input.value = tab.name;

		tab.labelElement.textContent = '';
		tab.labelElement.appendChild(input);
		input.focus();
		input.select();

		const commit = () => {
			const newName = input.value.trim() || tab.name;
			tab.name = newName;
			tab.labelElement.textContent = newName;
			tab.terminalInstance?.rename(newName);
		};

		const onBlur = () => {
			input.removeEventListener('blur', onBlur);
			input.removeEventListener('keydown', onKeydown);
			commit();
		};

		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				input.removeEventListener('blur', onBlur);
				input.removeEventListener('keydown', onKeydown);
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				input.removeEventListener('blur', onBlur);
				input.removeEventListener('keydown', onKeydown);
				tab.labelElement.textContent = tab.name;
			}
		};

		input.addEventListener('blur', onBlur);
		input.addEventListener('keydown', onKeydown);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._bodyDimension = { width, height };

		if (this._bodyContainer) {
			this._bodyContainer.style.height = `${height}px`;
			this._bodyContainer.style.width = `${width}px`;
		}

		const activeTab = this._tabs.find(t => t.id === this._activeTabId);
		if (activeTab && activeTab.kind === 'terminal' && activeTab.terminalInstance) {
			const termHeight = height - TAB_BAR_HEIGHT;
			activeTab.terminalInstance.layout({
				width,
				height: Math.max(0, termHeight),
			});
		}
	}

	override dispose(): void {
		for (const tab of this._tabs) {
			if (tab.kind === 'terminal' && tab.terminalInstance) {
				tab.terminalInstance.dispose();
			}
		}
		this._tabs = [];
		super.dispose();
	}
}
