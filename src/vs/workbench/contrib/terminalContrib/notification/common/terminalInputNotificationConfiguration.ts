/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IStringDictionary } from '../../../../../base/common/collections.js';
import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalInputNotificationSettingId {
	EnableInputNotification = 'terminal.integrated.enableInputNotification',
	InputNotificationSilenceMs = 'terminal.integrated.inputNotificationSilenceMs',
}

export const terminalInputNotificationConfiguration: IStringDictionary<IConfigurationPropertySchema> = {
	[TerminalInputNotificationSettingId.EnableInputNotification]: {
		description: localize('terminal.integrated.enableInputNotification', "Controls whether an OS notification is shown when a terminal process appears to be waiting for user input and the window is not focused. This is useful when working with multiple worktrees to know which window needs attention."),
		type: 'boolean',
		default: true
	},
	[TerminalInputNotificationSettingId.InputNotificationSilenceMs]: {
		description: localize('terminal.integrated.inputNotificationSilenceMs', "The number of milliseconds of output silence before a terminal is considered to be waiting for input. Lower values are more responsive but may produce false positives."),
		type: 'number',
		default: 5000,
		minimum: 1000,
		maximum: 30000,
	},
};
