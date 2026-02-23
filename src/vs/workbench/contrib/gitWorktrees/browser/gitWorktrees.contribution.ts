/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/gitWorktrees.css';
import { localize, localize2 } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IGitWorktreeService } from '../../../services/gitWorktrees/common/gitWorktrees.js';
import { GitWorktreeService } from './gitWorktreeService.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';

// Register service
registerSingleton(IGitWorktreeService, GitWorktreeService, InstantiationType.Delayed);

// Register commands
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'gitWorktrees.addRepository',
			title: localize2('addRepository', "Add Repository"),
			f1: true,
			category: localize2('gitWorktrees', "Git Worktrees"),
			icon: Codicon.add,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const gitWorktreeService = accessor.get(IGitWorktreeService);

		const result = await fileDialogService.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: localize('addRepo', "Add Repository"),
			title: localize('selectRepo', "Select Git Repository Root")
		});

		if (result && result.length > 0) {
			await gitWorktreeService.addRepository(result[0]);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'gitWorktrees.createWorktree',
			title: localize2('createWorktree', "Create Worktree"),
			f1: true,
			category: localize2('gitWorktrees', "Git Worktrees"),
			icon: Codicon.gitBranch,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const gitWorktreeService = accessor.get(IGitWorktreeService);

		const repos = gitWorktreeService.repositories;
		if (repos.length === 0) {
			return;
		}

		// If multiple repos, pick one
		let repoUri = repos[0].rootUri;
		if (repos.length > 1) {
			const items = repos.map(r => ({ label: r.name, description: r.rootUri.fsPath, repoUri: r.rootUri }));
			const pick = await quickInputService.pick(items, { placeHolder: localize('selectRepoForWorktree', "Select repository") });
			if (!pick) {
				return;
			}
			repoUri = pick.repoUri;
		}

		const branchName = await quickInputService.input({
			prompt: localize('enterBranchName', "Enter branch name for new worktree"),
			placeHolder: localize('branchNamePlaceholder', "feature/my-branch"),
		});

		if (!branchName) {
			return;
		}

		await gitWorktreeService.createWorktree(repoUri, branchName);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'gitWorktrees.createWorktreeForRepo',
			title: localize2('createWorktreeForRepo', "Create Worktree for Repository"),
			f1: false,
			category: localize2('gitWorktrees', "Git Worktrees"),
		});
	}

	override async run(accessor: ServicesAccessor, repoUri?: unknown): Promise<void> {
		if (!repoUri || !(repoUri instanceof URI)) {
			return;
		}
		const quickInputService = accessor.get(IQuickInputService);
		const gitWorktreeService = accessor.get(IGitWorktreeService);

		const branchName = await quickInputService.input({
			prompt: localize('enterBranchName', "Enter branch name for new worktree"),
			placeHolder: localize('branchNamePlaceholder', "feature/my-branch"),
		});

		if (!branchName) {
			return;
		}

		await gitWorktreeService.createWorktree(repoUri, branchName);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'gitWorktrees.refresh',
			title: localize2('refresh', "Refresh"),
			f1: false,
			category: localize2('gitWorktrees', "Git Worktrees"),
			icon: Codicon.refresh,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const gitWorktreeService = accessor.get(IGitWorktreeService);
		await gitWorktreeService.refresh();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'gitWorktrees.removeRepository',
			title: localize2('removeRepository', "Remove Repository"),
			f1: false,
			category: localize2('gitWorktrees', "Git Worktrees"),
		});
	}

	override run(accessor: ServicesAccessor, repoUri?: unknown): void {
		if (!repoUri || !(repoUri instanceof URI)) {
			return;
		}
		const gitWorktreeService = accessor.get(IGitWorktreeService);
		gitWorktreeService.removeRepository(repoUri);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'gitWorktrees.removeWorktree',
			title: localize2('removeWorktree', "Remove Worktree"),
			f1: false,
			category: localize2('gitWorktrees', "Git Worktrees"),
			icon: Codicon.archive,
		});
	}

	override async run(accessor: ServicesAccessor, worktreeUri?: unknown): Promise<void> {
		if (!worktreeUri || !(worktreeUri instanceof URI)) {
			return;
		}
		const dialogService = accessor.get(IDialogService);
		const gitWorktreeService = accessor.get(IGitWorktreeService);

		const { confirmed } = await dialogService.confirm({
			message: localize('confirmRemoveWorktree', "Remove this worktree?"),
			detail: localize('confirmRemoveWorktreeDetail', "This will remove the worktree at {0} and delete its working directory.", worktreeUri.fsPath),
			primaryButton: localize('remove', "Remove"),
		});

		if (!confirmed) {
			return;
		}

		await gitWorktreeService.removeWorktree(worktreeUri);
	}
});
