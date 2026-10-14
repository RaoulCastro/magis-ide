/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Magis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';
import { AgentHostMagisEnabledSettingId } from './agentService.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

configurationRegistry.registerConfiguration({
	id: 'chatAgentHostMagis',
	title: nls.localize('chatAgentHostMagisConfigurationTitle', "Magis Agent Host"),
	type: 'object',
	properties: {
		[AgentHostMagisEnabledSettingId]: {
			type: 'boolean',
			description: nls.localize('chat.agentHost.magis.enabled', "When enabled, the agent host registers the Magis provider for Magis Agent Service integration."),
			default: true,
			tags: ['experimental'],
		},
		'chat.agentHost.magis.baseUrl': {
			type: 'string',
			description: nls.localize('chat.agentHost.magis.baseUrl', "Base URL of the Magis Agent Service."),
			default: 'http://localhost:8787',
			tags: ['experimental'],
		},
		'chat.agentHost.magis.model': {
			type: 'string',
			description: nls.localize('chat.agentHost.magis.model', "Default model to use for Magis chat sessions."),
			default: 'qwen-code',
			tags: ['experimental'],
		},
	},
});
