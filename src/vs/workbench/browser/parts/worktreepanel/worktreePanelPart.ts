/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Part } from '../../part.js';
import { append, $ } from '../../../../base/browser/dom.js';
import { IListVirtualDelegate, IIdentityProvider } from '../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IGitWorktree, IGitWorktreeRepository, IGitWorktreeService } from '../../../services/gitWorktrees/common/gitWorktrees.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { isWeb } from '../../../../base/common/platform.js';

type TreeElement = IGitWorktreeRepository | IGitWorktree;

function isRepository(element: TreeElement): element is IGitWorktreeRepository {
	return 'worktrees' in element;
}

class WorktreeVirtualDelegate implements IListVirtualDelegate<TreeElement> {

	getHeight(): number {
		return 22;
	}

	getTemplateId(element: TreeElement): string {
		return isRepository(element) ? RepositoryRenderer.TEMPLATE_ID : WorktreeItemRenderer.TEMPLATE_ID;
	}
}

interface IRepositoryTemplate {
	readonly container: HTMLElement;
	readonly label: IconLabel;
	readonly addButton: HTMLElement;
	readonly disposables: DisposableStore;
}

class RepositoryRenderer implements ITreeRenderer<IGitWorktreeRepository, void, IRepositoryTemplate> {

	static readonly TEMPLATE_ID = 'repository';
	readonly templateId = RepositoryRenderer.TEMPLATE_ID;

	constructor(private readonly commandService: ICommandService) { }

	renderTemplate(container: HTMLElement): IRepositoryTemplate {
		const element = append(container, $('.git-worktree-repo'));
		const label = new IconLabel(element, { supportIcons: true });
		const addButton = append(element, $('a.git-worktree-repo-action.codicon'));
		addButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		addButton.title = localize('createWorktree', "Create Worktree");
		addButton.tabIndex = 0;
		addButton.setAttribute('role', 'button');
		const disposables = new DisposableStore();
		return { container: element, label, addButton, disposables };
	}

	renderElement(node: ITreeNode<IGitWorktreeRepository, void>, _index: number, templateData: IRepositoryTemplate): void {
		templateData.label.setLabel(node.element.name, undefined, {
			title: node.element.rootUri.fsPath
		});

		templateData.disposables.clear();
		const handler = (e: MouseEvent) => {
			e.stopPropagation();
			this.commandService.executeCommand('gitWorktrees.createWorktreeForRepo', node.element.rootUri);
		};
		templateData.addButton.addEventListener('click', handler);
		templateData.disposables.add({ dispose: () => templateData.addButton.removeEventListener('click', handler) });
	}

	disposeElement(_element: ITreeNode<IGitWorktreeRepository, void>, _index: number, templateData: IRepositoryTemplate): void {
		templateData.disposables.clear();
	}

	disposeTemplate(templateData: IRepositoryTemplate): void {
		templateData.disposables.dispose();
		templateData.label.dispose();
	}
}

interface IWorktreeItemTemplate {
	readonly icon: HTMLElement;
	readonly label: IconLabel;
	readonly archiveButton: HTMLElement;
	readonly disposables: DisposableStore;
}

class WorktreeItemRenderer implements ITreeRenderer<IGitWorktree, void, IWorktreeItemTemplate> {

	static readonly TEMPLATE_ID = 'worktree';
	readonly templateId = WorktreeItemRenderer.TEMPLATE_ID;

	constructor(private readonly commandService: ICommandService) { }

	renderTemplate(container: HTMLElement): IWorktreeItemTemplate {
		const element = append(container, $('.git-worktree-item'));
		const icon = append(element, $('.git-worktree-icon'));
		const label = new IconLabel(element, { supportIcons: true });
		const archiveButton = append(element, $('a.git-worktree-item-action.codicon'));
		archiveButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.archive));
		archiveButton.title = localize('removeWorktree', "Remove Worktree");
		archiveButton.tabIndex = 0;
		archiveButton.setAttribute('role', 'button');
		const disposables = new DisposableStore();
		return { icon, label, archiveButton, disposables };
	}

	renderElement(node: ITreeNode<IGitWorktree, void>, _index: number, templateData: IWorktreeItemTemplate): void {
		const worktree = node.element;
		const themeIcon = worktree.isCurrent
			? Codicon.check
			: worktree.isDetached
				? Codicon.gitCommit
				: Codicon.gitBranch;

		templateData.icon.className = 'git-worktree-icon ' + ThemeIcon.asClassName(themeIcon);

		const branchLabel = worktree.isDetached
			? worktree.branch.substring(0, 8)
			: worktree.branch;

		templateData.label.setLabel(branchLabel, worktree.path, {
			title: worktree.path
		});

		// Hide archive button for main worktree
		templateData.archiveButton.style.display = worktree.isMain ? 'none' : '';

		templateData.disposables.clear();
		if (!worktree.isMain) {
			const handler = (e: MouseEvent) => {
				e.stopPropagation();
				this.commandService.executeCommand('gitWorktrees.removeWorktree', worktree.uri);
			};
			templateData.archiveButton.addEventListener('click', handler);
			templateData.disposables.add({ dispose: () => templateData.archiveButton.removeEventListener('click', handler) });
		}
	}

	disposeElement(_element: ITreeNode<IGitWorktree, void>, _index: number, templateData: IWorktreeItemTemplate): void {
		templateData.disposables.clear();
	}

	disposeTemplate(templateData: IWorktreeItemTemplate): void {
		templateData.disposables.dispose();
		templateData.label.dispose();
	}
}

function isService(element: unknown): element is IGitWorktreeService {
	if (typeof element !== 'object' || element === null) {
		return false;
	}
	// Cannot use 'in' operator because delayed DI services use Proxy without a 'has' trap
	const candidate = element as IGitWorktreeService;
	return candidate.repositories !== undefined && candidate.onDidChange !== undefined;
}

class WorktreeDataSource implements IAsyncDataSource<IGitWorktreeService, TreeElement> {

	hasChildren(element: IGitWorktreeService | TreeElement): boolean {
		if (isService(element)) {
			return true;
		}
		return isRepository(element);
	}

	getChildren(element: IGitWorktreeService | TreeElement): TreeElement[] {
		if (isService(element)) {
			return [...element.repositories];
		}
		if (isRepository(element)) {
			return [...element.worktrees];
		}
		return [];
	}
}

class WorktreeIdentityProvider implements IIdentityProvider<TreeElement> {

	getId(element: TreeElement): string {
		if (isRepository(element)) {
			return `repo:${element.rootUri.toString()}`;
		}
		return `worktree:${element.uri.toString()}`;
	}
}

class WorktreeAccessibilityProvider implements IListAccessibilityProvider<TreeElement> {

	getWidgetAriaLabel(): string {
		return localize('gitWorktrees', "Git Worktrees");
	}

	getAriaLabel(element: TreeElement): string | null {
		if (isRepository(element)) {
			return element.name;
		}
		return element.branch;
	}
}

export class WorktreePanelPart extends Part {

	static readonly ID = 'workbench.parts.worktreepanel';

	readonly minimumWidth = isWeb ? 0 : 170;
	readonly maximumWidth = isWeb ? 0 : 400;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;

	private tree: WorkbenchAsyncDataTree<IGitWorktreeService, TreeElement> | undefined;
	private treeContainer: HTMLElement | undefined;
	private addRepoBar: HTMLElement | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IGitWorktreeService private readonly gitWorktreeService: IGitWorktreeService,
		@IHostService private readonly hostService: IHostService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(WorktreePanelPart.ID, { hasTitle: true }, themeService, storageService, layoutService);
	}

	override create(parent: HTMLElement, options?: object): void {
		this.element = parent;
		super.create(parent, options);
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		const titleArea = append(parent, $('.worktree-panel-title'));

		const titleLabel = append(titleArea, $('.worktree-panel-title-label'));
		titleLabel.textContent = localize('worktrees', "Worktrees");

		const toolbar = append(titleArea, $('.worktree-panel-title-toolbar'));

		const refreshButton = append(toolbar, $('a.action-label.codicon'));
		refreshButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.refresh));
		refreshButton.title = localize('refresh', "Refresh");
		refreshButton.tabIndex = 0;
		refreshButton.setAttribute('role', 'button');
		const refreshHandler = () => this.commandService.executeCommand('gitWorktrees.refresh');
		refreshButton.addEventListener('click', refreshHandler);
		this._register({ dispose: () => refreshButton.removeEventListener('click', refreshHandler) });

		return titleArea;
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const contentArea = append(parent, $('.worktree-panel-content'));

		// Add Repo button bar at top
		this.addRepoBar = append(contentArea, $('.worktree-panel-add-repo'));
		const addRepoButton = append(this.addRepoBar, $('a.worktree-panel-add-repo-button'));
		const addRepoIcon = append(addRepoButton, $('span.codicon'));
		addRepoIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(addRepoButton, document.createTextNode(localize('addRepo', "Add Repo")));
		addRepoButton.tabIndex = 0;
		addRepoButton.setAttribute('role', 'button');
		const addRepoHandler = () => this.commandService.executeCommand('gitWorktrees.addRepository');
		addRepoButton.addEventListener('click', addRepoHandler);
		this._register({ dispose: () => addRepoButton.removeEventListener('click', addRepoHandler) });

		// Tree
		this.treeContainer = append(contentArea, $('.worktree-panel-tree'));
		this.createTree();

		this._register(this.gitWorktreeService.onDidChange(() => this.updateTree()));
		this.updateTree();

		return contentArea;
	}

	private createTree(): void {
		const delegate = new WorktreeVirtualDelegate();
		const renderers = [
			new RepositoryRenderer(this.commandService),
			new WorktreeItemRenderer(this.commandService),
		];
		const dataSource = new WorktreeDataSource();

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<IGitWorktreeService, TreeElement, void>,
			'GitWorktrees',
			this.treeContainer!,
			delegate,
			renderers,
			dataSource,
			{
				identityProvider: new WorktreeIdentityProvider(),
				accessibilityProvider: new WorktreeAccessibilityProvider(),
			}
		) as WorkbenchAsyncDataTree<IGitWorktreeService, TreeElement, void>;

		this._register(this.tree);
		this._register(this.tree.onDidOpen(e => this.onDidOpenElement(e.element)));
	}

	private async updateTree(): Promise<void> {
		if (!this.tree) {
			return;
		}

		if (this.tree.getInput() !== this.gitWorktreeService) {
			await this.tree.setInput(this.gitWorktreeService);
		}
		await this.tree.updateChildren(this.gitWorktreeService, true);
		this.tree.expandAll();
		this.layoutTree();
	}

	private layoutTree(): void {
		if (!this.tree || !this.dimension) {
			return;
		}
		const { contentSize } = this.layoutContents(this.dimension.width, this.dimension.height);
		const addRepoBarHeight = this.addRepoBar ? this.addRepoBar.offsetHeight : 0;
		const treeHeight = Math.max(0, contentSize.height - addRepoBarHeight);

		this.tree.layout(treeHeight, contentSize.width);

		if (this.treeContainer) {
			this.treeContainer.style.height = `${treeHeight}px`;
			this.treeContainer.style.width = `${contentSize.width}px`;
		}
	}

	private onDidOpenElement(element: TreeElement | undefined): void {
		if (!element || isRepository(element)) {
			return;
		}

		const worktree = element;
		if (worktree.isCurrent) {
			return;
		}

		this.hostService.openWindow(
			[{ folderUri: worktree.uri }],
			{ forceReuseWindow: true }
		);
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		this.layoutTree();
	}

	toJSON(): object {
		return {
			type: Parts.WORKTREE_PANEL_PART
		};
	}
}
