/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Magis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../log/common/log.js';
import { IRequestService } from '../../../request/common/request.js';
import { MagisAgent } from './magisAgent.js';
import type { IAgent } from '../../common/agentService.js';

export class MagisAgentStarter {
	constructor(
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
	) {}

	async createAgent(): Promise<IAgent> {
		const baseUrl = process.env.MAGIS_AGENT_BASE_URL || 'http://localhost:8787';
		const authToken = process.env.MAGIS_AGENT_API_KEY;

		this.logService.info('[MagisAgentStarter] Creating Magis agent with baseUrl:', baseUrl);

		const agent = new MagisAgent(
			{
				baseUrl,
				authToken,
			},
			this.requestService
		);

		return agent;
	}

	getProviderId(): string {
		return 'magis';
	}

	isEnabled(): boolean {
		return true;
	}
}
