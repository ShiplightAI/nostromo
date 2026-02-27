/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { DiscordStatusContribution } from './discordStatus.js';

registerWorkbenchContribution2(DiscordStatusContribution.ID, DiscordStatusContribution, WorkbenchPhase.AfterRestored);

registerAction2(class OpenDiscordAction extends Action2 {

	constructor() {
		super({
			id: 'workbench.action.openDiscord',
			title: localize2('openDiscord', 'Open Discord'),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const openerService = accessor.get(IOpenerService);
		const productService = accessor.get(IProductService);

		if (productService.discordUrl) {
			await openerService.open(URI.parse(productService.discordUrl));
		}
	}
});
