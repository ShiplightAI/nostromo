/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable no-restricted-syntax, no-restricted-globals */

/**
 * Electron shell window entry point.
 *
 * Uses IPC to communicate with main process services for
 * file browsing and git worktree operations. Workbench instances
 * are loaded as WebContentsView (managed by ShellViewManager in main process)
 * rather than iframes, so no HTTP server is needed.
 */

(async function () {
	const preloadGlobals: { context: { resolveConfiguration(): Promise<Record<string, unknown>> }; ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } = (window as unknown as { vscode: typeof preloadGlobals }).vscode;
	const configuration = await preloadGlobals.context.resolveConfiguration();
	const ipcRenderer = preloadGlobals.ipcRenderer;

	// Get the window ID for view management IPC
	const windowId = (configuration.windowId as number) ?? -1;

	// Send the full native window configuration to the main process
	// so the ShellViewManager can clone it for embedded workbench views
	ipcRenderer.invoke('vscode:shellView-setBaseConfig', configuration);

	// Wait for the shared shell script to load, then instantiate with Electron backend
	const script = document.createElement('script');
	script.type = 'module';
	script.src = '../../browser/workbench/shell.js';
	script.onload = () => {
		const shellWindow = window as unknown as { ShellApplication?: new (backend: unknown) => unknown; createElectronBackend?: (windowId: number, ipcRenderer: unknown, container: HTMLElement) => unknown };

		if (shellWindow.createElectronBackend && shellWindow.ShellApplication) {
			const iframeContainer = document.getElementById('iframe-container')!;
			const backend = shellWindow.createElectronBackend(windowId, ipcRenderer, iframeContainer);
			new shellWindow.ShellApplication(backend);
		}
	};
	document.body.appendChild(script);
})();
