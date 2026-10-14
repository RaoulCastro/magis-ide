import * as vscode from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { AbstractOpenAICompatibleLMProvider, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';

export interface MagisProviderConfig extends LanguageModelChatConfiguration {
	readonly endpointUrl?: string;
}

export class MagisLMProvider extends AbstractOpenAICompatibleLMProvider<MagisProviderConfig> {

	public static readonly providerName = 'Magis';
	public static readonly providerId = this.providerName.toLowerCase();

	constructor(
		knownModels: BYOKKnownModels,
		byokStorageService: IBYOKStorageService,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			MagisLMProvider.providerId,
			MagisLMProvider.providerName,
			knownModels,
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService
		);
	}

	protected override getModelsBaseUrl(configuration?: MagisProviderConfig): string {
		const configUrl = this._configurationService.getValue<string>('magis.ai.endpoint');
		if (configUrl) {
			return configUrl;
		}
		return 'http://127.0.0.1:8000/v1'; // Default local vLLM / gateway
	}

	protected override async configureDefaultGroupWithApiKeyOnly(): Promise<string | undefined> {
		try {
			const session = await vscode.authentication.getSession('magis', ['read:user'], { silent: true });
			return session?.accessToken;
		} catch {
			return undefined;
		}
	}

	protected override async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<MagisProviderConfig>): Promise<OpenAIEndpoint> {
		let token = '';
		try {
			const session = await vscode.authentication.getSession('magis', ['read:user'], { silent: true });
			if (session) {
				token = session.accessToken;
			}
		} catch (err) {
			this._logService.error('MagisLMProvider: Error fetching magis auth session', err);
		}

		const modelInfo = this.getModelInfo(model.id, model.url);
		const url = modelInfo.supported_endpoints?.includes(ModelSupportedEndpoint.Responses) ?
			`${model.url}/responses` :
			`${model.url}/chat/completions`;
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, token, url);
	}

	protected override getModelInfo(modelId: string, modelUrl: string): IChatModelInformation {
		const modelInfo = super.getModelInfo(modelId, modelUrl);
		modelInfo.supported_endpoints = [
			ModelSupportedEndpoint.ChatCompletions,
			ModelSupportedEndpoint.Responses
		];
		return modelInfo;
	}
}
