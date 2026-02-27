/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export class DiscordStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.discordStatus';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IProductService productService: IProductService,
	) {
		super();

		if (productService.discordUrl) {
			this._register(statusbarService.addEntry(
				{
					name: localize('status.discord', "Discord"),
					text: '$(comment-discussion)',
					ariaLabel: localize('status.discord.ariaLabel', "Join our Discord community"),
					tooltip: localize('status.discord.tooltip', "Join our Discord community"),
					command: 'workbench.action.openDiscord',
					showInAllWindows: true,
				},
				DiscordStatusContribution.ID,
				StatusbarAlignment.RIGHT,
				-Number.MAX_VALUE
			));
		}
	}
}
