/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execSync } from 'child_process';

interface CliAgentConfig {
	profileId: string;
	name: string;
	command: string;
	installUrl: string;
	shellArgs?: string[];
}

const CLI_AGENTS: CliAgentConfig[] = [
	{
		profileId: 'claude-code.claudeProfile',
		name: 'Claude Code',
		command: 'claude',
		installUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
	},
	{
		profileId: 'claude-code.codexProfile',
		name: 'OpenAI Codex',
		command: 'codex',
		installUrl: 'https://github.com/openai/codex',
	},
	{
		profileId: 'claude-code.geminiProfile',
		name: 'Gemini CLI',
		command: 'gemini',
		installUrl: 'https://github.com/google-gemini/gemini-cli',
	},
];

function resolveCommand(command: string): string | undefined {
	try {
		const resolved = execSync(`which ${command}`, { encoding: 'utf-8' }).trim();
		return resolved || undefined;
	} catch {
		return undefined;
	}
}

class CliAgentProfileProvider implements vscode.TerminalProfileProvider {
	constructor(private readonly config: CliAgentConfig) { }

	provideTerminalProfile(_token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
		const shellPath = resolveCommand(this.config.command);
		if (!shellPath) {
			vscode.window.showInformationMessage(
				`${this.config.name} CLI not found. Install it from ${this.config.installUrl}`,
				'Open Install Page'
			).then(selection => {
				if (selection === 'Open Install Page') {
					vscode.env.openExternal(vscode.Uri.parse(this.config.installUrl));
				}
			});
			return undefined;
		}

		return new vscode.TerminalProfile({
			name: this.config.name,
			shellPath,
			shellArgs: this.config.shellArgs,
			iconPath: new vscode.ThemeIcon(this.config.profileId.includes('claude') ? 'claude' : this.config.profileId.includes('codex') ? 'openai' : 'terminal'),
		});
	}
}

export function activate(context: vscode.ExtensionContext): void {
	for (const agentConfig of CLI_AGENTS) {
		const provider = new CliAgentProfileProvider(agentConfig);
		context.subscriptions.push(
			vscode.window.registerTerminalProfileProvider(agentConfig.profileId, provider)
		);
	}
}

export function deactivate(): void {
	// Nothing to dispose
}
