/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IGitWorktree {
	readonly name: string;
	readonly path: string;
	readonly uri: URI;
	readonly branch: string;
	readonly isCurrent: boolean;
	readonly isMain: boolean;
	readonly isDetached: boolean;
}

export interface IGitWorktreeRepository {
	readonly rootUri: URI;
	readonly name: string;
	readonly worktrees: IGitWorktree[];
}

export const IGitWorktreeService = createDecorator<IGitWorktreeService>('gitWorktreeService');

export interface IGitWorktreeService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	readonly repositories: readonly IGitWorktreeRepository[];

	addRepository(uri: URI): Promise<void>;
	removeRepository(uri: URI): void;
	refresh(): Promise<void>;
	createWorktree(repoUri: URI, branchName: string): Promise<IGitWorktree>;
	removeWorktree(worktreeUri: URI): Promise<void>;
}
