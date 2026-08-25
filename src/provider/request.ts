import vscode from 'vscode';
import { AuthManager } from '../auth';
import { GLMClient } from '../client';
import {
	findModelDefinition,
	getApiModelId,
	getApiProtocol,
	getBaseUrl,
	getBaseUrlOverride,
	getCodeSimplifierEnabled,
	getMaxTokens,
	getPonytailMode,
	getRules,
} from '../config';
import { isOfficialGLMBaseUrl, resolveEndpointBaseUrl, resolveEndpointProtocol } from '../endpoint';
import { t } from '../i18n';
import type { ApiProtocol, GLMRequest, ModelDefinition, PricingCurrency } from '../types';
import { injectCodeSimplifierSystemMessage } from './code-simplifier';
import { convertMessages, countMessageChars } from './convert';
import { dumpGLMRequest, type CacheDiagnosticsRecorder, type CacheDiagnosticsRun } from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import { injectPonytailSystemMessage } from './ponytail';
import { getPricingCurrencyForBaseUrl } from './pricing/currency';
import type { ReplayMarkerMetadata } from './replay';
import { shouldForceThinkingNone, type RequestKind } from './routing';
import { injectRulesSystemMessage } from './rules';
import type { ConversationSegment } from './segment';
import { REQUEST_KINDS_ELIGIBLE_FOR_TOOL_TRIMMING } from './tools/consts';
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';
import { resolveImageMessages, type VisionDescriber } from './vision';

// ---- GLMClient instance cache ----
// Reuse client objects by `${baseUrl}:${protocol}` to avoid per-request GC
// pressure and enable connection reuse via Node's fetch pool.
const clientCache = new Map<string, GLMClient>();

function getCachedClient(baseUrl: string, apiKey: string, protocol: ApiProtocol): GLMClient {
	const key = `${baseUrl}:${apiKey}:${protocol}`;
	let client = clientCache.get(key);
	if (client) {
		return client;
	}
	client = new GLMClient(baseUrl, apiKey, protocol);
	clientCache.set(key, client);
	return client;
}

/**
 * Clear cached GLMClient instances. Call when configuration changes
 * (base URL, API key, or protocol) to ensure stale clients are discarded.
 */
export function clearClientCache(): void {
	clientCache.clear();
}

export interface PreparedChatRequest {
	client: GLMClient;
	request: GLMRequest;
	isThinkingModel: boolean;
	totalRequestChars: number;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	modelDefinition?: ModelDefinition;
	pricingCurrency?: PricingCurrency;
	visionMarkerTextChars?: number;
	initialResponseNotice?: string;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
	getVisionDescriber: () => Promise<VisionDescriber | undefined>;
	requestKind: RequestKind;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	token,
	cacheDiagnostics,
	getVisionDescriber,
	requestKind,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const modelDef = findModelDefinition(modelInfo.id);
	// Per-model endpoint pinning: OpenCode Go models that are only reachable
	// through a specific wire protocol (Anthropic for MiniMax/Qwen, OpenAI for
	// GLM/Kimi/DeepSeek/MiMo) pin their endpoint preset so they always route to
	// the correct base URL + protocol, independently of the global `endpoint`
	// setting. A non-empty `baseUrl` override still wins for the host, but the
	// pinned protocol is respected so the request shape matches what the model
	// expects. Unpinned models (e.g. GLM-5.2) follow the active endpoint preset.
	const baseUrlOverride = getBaseUrlOverride();
	const modelEndpoint = modelDef?.endpointPreset;
	let baseUrl: string;
	let apiProtocol: ApiProtocol;
	if (baseUrlOverride) {
		baseUrl = baseUrlOverride;
		apiProtocol = modelEndpoint ? resolveEndpointProtocol(modelEndpoint) : getApiProtocol();
	} else if (modelEndpoint) {
		baseUrl = resolveEndpointBaseUrl(modelEndpoint);
		apiProtocol = resolveEndpointProtocol(modelEndpoint);
	} else {
		baseUrl = getBaseUrl();
		apiProtocol = getApiProtocol();
	}
	// Key follows the endpoint: Go URLs use the Go-subscription key, Zen URLs
	// the Zen pay-as-you-go key, everything else the legacy single key.
	const apiKey = await authManager.getApiKeyForEndpoint(baseUrl);
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}
	const client = getCachedClient(baseUrl, apiKey, apiProtocol);
	const isThinkingModel = modelDef?.capabilities.thinking ?? false;
	const maxTokens = getMaxTokens();
	const apiModelId = getApiModelId(modelInfo.id);

	const visionResolution = await resolveImageMessages(messages, token, getVisionDescriber);
	const resolvedMessages = visionResolution.messages;
	const glmMessages = convertMessages(resolvedMessages, isThinkingModel, modelDef?.id);
	const tools = prepareRequestTools(
		modelDef?.capabilities.toolCalling,
		options,
		modelDef?.capabilities.preferredToolLimit,
		requestKind,
	);

	const ponytailMode = getPonytailMode();
	// Coding-discipline instructions only help real coding requests (main-agent,
	// background). Injecting them into utility calls (chat-title, git-commit,
	// rename, classifiers) wastes tokens, pollutes the prompt cache, and adds
	// off-task noise — so gate on the same set tool-trimming already uses.
	const isCodingRequest = REQUEST_KINDS_ELIGIBLE_FOR_TOOL_TRIMMING.has(requestKind);
	let glmMessagesWithPonytail = isCodingRequest
		? injectRulesSystemMessage(glmMessages, getRules())
		: glmMessages;
	glmMessagesWithPonytail = isCodingRequest
		? injectPonytailSystemMessage(glmMessagesWithPonytail, ponytailMode)
		: glmMessagesWithPonytail;

	// Code Simplifier runs on top of (downgraded) Ponytail for clean, refined output.
	if (isCodingRequest && getCodeSimplifierEnabled()) {
		glmMessagesWithPonytail = injectCodeSimplifierSystemMessage(glmMessagesWithPonytail);
	}

	const totalRequestChars = countMessageChars(glmMessagesWithPonytail, tools);
	const baseRequest: GLMRequest = {
		model: apiModelId,
		messages: glmMessagesWithPonytail,
		stream: true,
		stream_options: { include_usage: true },
		tools,
		tool_choice: tools && tools.length > 0 ? ('auto' as const) : undefined,
		// tool_stream: tools && tools.length > 0 ? true : undefined,
		tool_stream: tools && tools.length > 0 && isOfficialGLMBaseUrl(baseUrl) ? true : undefined,

		max_tokens: maxTokens,
	};
	const configuredThinkingEffort = getConfiguredThinkingEffort(
		options as ModelConfigurationOptions,
	);
	// Only force helper requests into disabled thinking on the official API.
	// Custom endpoints keep their configured effort to preserve pre-#137 request shape.
	const forceNoneThinking = shouldForceThinkingNone(requestKind) && isOfficialGLMBaseUrl(baseUrl);
	const thinkingEffort = forceNoneThinking ? 'none' : configuredThinkingEffort;
	const supportsReasoningEffort = modelDef?.supportsReasoningEffort ?? false;
	const request: GLMRequest = {
		...baseRequest,
		...(isThinkingModel
			? {
					thinking: {
						type: thinkingEffort === 'none' ? ('disabled' as const) : ('enabled' as const),
						...(thinkingEffort === 'none' ? {} : { clear_thinking: false }),
					},
					...(thinkingEffort !== 'none' && supportsReasoningEffort
						? { reasoning_effort: thinkingEffort }
						: {}),
				}
			: {}),
	};
	dumpGLMRequest(request, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		requestOptions: options,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	// Guard: skip heavy diagnostics options construction when debug logging
	// is disabled. beginRequest() already returns a noop, but this avoids
	// building the BeginCacheDiagnosticsOptions object with full message arrays.
	const diagnosticsRun = cacheDiagnostics.isEnabled()
		? cacheDiagnostics.beginRequest({
				request,
				segment,
				requestKind,
				vscodeModelId: modelInfo.id,
				isThinkingModel,
				thinkingEffort,
				maxTokens,
				inputMessages: messages,
				resolvedMessages,
				visionModelId: visionResolution.visionModelId,
				visionProxySource: visionResolution.visionProxySource,
				visionStats: visionResolution.stats,
				ponytailMode,
			})
		: createNoopCacheDiagnosticsRun();

	return {
		client,
		request,
		isThinkingModel,
		totalRequestChars,
		trailingToolResultIds: collectTrailingToolResultIds(glmMessagesWithPonytail),
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: visionResolution.replayMarkerMetadata,
		modelDefinition: modelDef,
		pricingCurrency: getPricingCurrencyForBaseUrl(baseUrl),
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
		initialResponseNotice: visionResolution.initialResponseNotice,
	};
}

/** No-op cache diagnostics run used when debug logging is disabled. */
function createNoopCacheDiagnosticsRun(): CacheDiagnosticsRun {
	return {
		onDone() {},
		onCancellationTokenRequested() {},
		onReplayMarkerReport() {},
		onUsage() {},
	};
}
