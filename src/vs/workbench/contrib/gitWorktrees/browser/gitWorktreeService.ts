/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IGitWorktree, IGitWorktreeRepository, IGitWorktreeService } from '../../../services/gitWorktrees/common/gitWorktrees.js';

const STORAGE_KEY = 'gitWorktrees.trackedRepositories';

export class GitWorktreeService extends Disposable implements IGitWorktreeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _repositories: IGitWorktreeRepository[] = [];
	get repositories(): readonly IGitWorktreeRepository[] { return this._repositories; }

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._loadTrackedRepos();
		// Defer refresh to avoid blocking startup
		Promise.resolve().then(() => this.refresh()).catch(() => { /* ignore startup refresh errors */ });
	}

	private _loadTrackedRepos(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.PROFILE, '[]');
		try {
			const uris: string[] = JSON.parse(raw);
			this._trackedRepoUris = uris.map(u => URI.parse(u));
		} catch {
			this._trackedRepoUris = [];
		}
	}

	private _trackedRepoUris: URI[] = [];

	private _saveTrackedRepos(): void {
		const raw = JSON.stringify(this._trackedRepoUris.map(u => u.toString()));
		this.storageService.store(STORAGE_KEY, raw, StorageScope.PROFILE, StorageTarget.USER);
	}

	async addRepository(uri: URI): Promise<void> {
		if (this._trackedRepoUris.some(u => u.toString() === uri.toString())) {
			await this.refresh();
			return;
		}
		this._trackedRepoUris.push(uri);
		this._saveTrackedRepos();
		await this.refresh();
	}

	removeRepository(uri: URI): void {
		const uriStr = uri.toString();
		this._trackedRepoUris = this._trackedRepoUris.filter(u => u.toString() !== uriStr);
		this._saveTrackedRepos();
		this._repositories = this._repositories.filter(r => r.rootUri.toString() !== uriStr);
		this._onDidChange.fire();
	}

	async refresh(): Promise<void> {
		const repos: IGitWorktreeRepository[] = [];
		for (const repoUri of this._trackedRepoUris) {
			try {
				const repo = await this._scanRepository(repoUri);
				if (repo) {
					repos.push(repo);
				}
			} catch {
				// Skip repos that fail to scan
			}
		}
		this._repositories = repos;
		this._onDidChange.fire();
	}

	async createWorktree(repoUri: URI, branchName: string): Promise<IGitWorktree> {
		// Determine the worktree path: ~/Shiplight/<repoName>/branch_<branchName>
		const repoPath = repoUri.path;
		const repoName = repoPath.substring(repoPath.lastIndexOf('/') + 1);
		const safeBranchName = branchName.replace(/\//g, '_');
		const worktreePath = `/Users/feng/Shiplight/${repoName}/branch_${safeBranchName}`;
		const worktreeUri = repoUri.with({ path: worktreePath });

		// Create the worktree directory
		await this.fileService.createFolder(worktreeUri);

		// We need to run `git worktree add` — since we're in the browser layer,
		// we create the worktree structure manually:
		// 1. Create .git file pointing to the main repo's worktrees dir
		const gitDirUri = URI.joinPath(repoUri, '.git');
		const mainGitPath = await this._resolveGitDir(gitDirUri);

		const worktreeEntryName = safeBranchName;
		const worktreesDir = URI.joinPath(mainGitPath, 'worktrees', worktreeEntryName);
		await this.fileService.createFolder(worktreesDir);

		// Write the .git file in the new worktree
		const dotGitContent = `gitdir: ${worktreesDir.path}\n`;
		const encoder = new TextEncoder();
		await this.fileService.writeFile(
			URI.joinPath(worktreeUri, '.git'),
			VSBuffer.wrap(encoder.encode(dotGitContent))
		);

		// Write HEAD ref for the new branch
		const headContent = `ref: refs/heads/${branchName}\n`;
		await this.fileService.writeFile(
			URI.joinPath(worktreesDir, 'HEAD'),
			VSBuffer.wrap(encoder.encode(headContent))
		);

		// Write gitdir pointing back to the worktree
		const gitdirContent = `${worktreeUri.path}/.git\n`;
		await this.fileService.writeFile(
			URI.joinPath(worktreesDir, 'gitdir'),
			VSBuffer.wrap(encoder.encode(gitdirContent))
		);

		await this.refresh();

		const repo = this._repositories.find(r => r.rootUri.toString() === repoUri.toString());
		const worktree = repo?.worktrees.find(w => w.uri.toString() === worktreeUri.toString());
		if (!worktree) {
			throw new Error('Failed to create worktree');
		}
		return worktree;
	}

	async removeWorktree(worktreeUri: URI): Promise<void> {
		// Find the repo that contains this worktree
		const repo = this._repositories.find(r => r.worktrees.some(w => w.uri.toString() === worktreeUri.toString()));
		if (!repo) {
			throw new Error('Worktree not found in any tracked repository');
		}

		// Find the common git dir for the repo
		const gitUri = URI.joinPath(repo.rootUri, '.git');
		const commonGitDir = await this._resolveGitDir(gitUri);

		// Find the worktree entry in .git/worktrees/ that points to this worktree path
		const worktreesDir = URI.joinPath(commonGitDir, 'worktrees');
		try {
			const stat = await this.fileService.resolve(worktreesDir);
			if (stat.children) {
				for (const child of stat.children) {
					if (!child.isDirectory) {
						continue;
					}
					try {
						const gitdirContent = (await this.fileService.readFile(URI.joinPath(child.resource, 'gitdir'))).value.toString().trim();
						const entryPath = gitdirContent.replace(/\/\.git\s*$/, '');
						if (entryPath === worktreeUri.path) {
							// Delete the worktree entry from .git/worktrees/<name>/
							await this.fileService.del(child.resource, { recursive: true });
							break;
						}
					} catch {
						// Skip unreadable entries
					}
				}
			}
		} catch {
			// No worktrees directory
		}

		// Delete the worktree working directory
		try {
			await this.fileService.del(worktreeUri, { recursive: true });
		} catch {
			// Directory may already be gone
		}

		await this.refresh();
	}

	private async _resolveGitDir(gitUri: URI): Promise<URI> {
		try {
			const stat = await this.fileService.stat(gitUri);
			if (stat.isDirectory) {
				return gitUri;
			}
		} catch {
			// not found
		}

		// .git is a file (worktree) — read it to find the actual git dir
		try {
			const content = await this.fileService.readFile(gitUri);
			const text = content.value.toString().trim();
			const match = text.match(/^gitdir:\s*(.+)$/);
			if (match) {
				const gitdirPath = match[1];
				// Resolve relative to the parent of .git
				const parentUri = URI.joinPath(gitUri, '..');
				return URI.joinPath(parentUri, gitdirPath);
			}
		} catch {
			// ignore
		}
		return gitUri;
	}

	private async _scanRepository(repoUri: URI): Promise<IGitWorktreeRepository | undefined> {
		const gitUri = URI.joinPath(repoUri, '.git');

		// Find the common git dir (for worktrees, go up from .git/worktrees/name)
		let commonGitDir: URI;
		try {
			const stat = await this.fileService.stat(gitUri);
			if (stat.isDirectory) {
				// This is the main repo
				commonGitDir = gitUri;
			} else {
				// This is a worktree — resolve to common dir
				const resolved = await this._resolveGitDir(gitUri);
				// resolved might be something like /path/to/main/.git/worktrees/name
				// Common dir is /path/to/main/.git
				const resolvedPath = resolved.path;
				const worktreesIdx = resolvedPath.indexOf('/worktrees/');
				if (worktreesIdx !== -1) {
					commonGitDir = resolved.with({ path: resolvedPath.substring(0, worktreesIdx) });
				} else {
					commonGitDir = resolved;
				}
			}
		} catch {
			return undefined;
		}

		const worktrees: IGitWorktree[] = [];
		const currentFolders = this.workspaceContextService.getWorkspace().folders.map(f => f.uri.toString());
		const repoName = repoUri.path.substring(repoUri.path.lastIndexOf('/') + 1);

		// Read main worktree HEAD
		try {
			const headContent = (await this.fileService.readFile(URI.joinPath(commonGitDir, 'HEAD'))).value.toString().trim();
			const isDetached = !headContent.startsWith('ref: ');
			const branch = headContent.replace(/^ref: refs\/heads\//, '');
			const mainPath = URI.joinPath(commonGitDir, '..').path;
			const mainUri = commonGitDir.with({ path: mainPath });

			worktrees.push({
				name: repoName,
				path: mainPath,
				uri: mainUri,
				branch,
				isCurrent: currentFolders.some(f => f === mainUri.toString()),
				isMain: true,
				isDetached,
			});
		} catch {
			return undefined;
		}

		// Read worktrees directory
		try {
			const worktreesDir = URI.joinPath(commonGitDir, 'worktrees');
			const stat = await this.fileService.resolve(worktreesDir);
			if (stat.children) {
				for (const child of stat.children) {
					if (!child.isDirectory) {
						continue;
					}
					try {
						const headContent = (await this.fileService.readFile(URI.joinPath(child.resource, 'HEAD'))).value.toString().trim();
						const gitdirContent = (await this.fileService.readFile(URI.joinPath(child.resource, 'gitdir'))).value.toString().trim();

						const isDetached = !headContent.startsWith('ref: ');
						const branch = headContent.replace(/^ref: refs\/heads\//, '');
						// gitdir points to the .git file in the worktree — remove /.git suffix to get worktree path
						const worktreePath = gitdirContent.replace(/\/\.git\s*$/, '');
						const worktreeUri = child.resource.with({ path: worktreePath });

						worktrees.push({
							name: child.name,
							path: worktreePath,
							uri: worktreeUri,
							branch,
							isCurrent: currentFolders.some(f => f === worktreeUri.toString()),
							isMain: false,
							isDetached,
						});
					} catch {
						// Skip unreadable worktrees
					}
				}
			}
		} catch {
			// No worktrees directory — that's fine
		}

		return {
			rootUri: repoUri,
			name: repoName,
			worktrees,
		};
	}
}
