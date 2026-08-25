import vscode from 'vscode';
import { t } from '../i18n';
import type { ModelDefinition, PricingCurrency } from '../types';
import { toModelCostInfo, type ModelCostInformation } from './pricing/costs';

/**
 * NOTE: Non-public API surface.
 *
 * The fields below (`configurationSchema` on chat info, cost metadata,
 * `modelConfiguration` on response options, plus `isBYOK` / `isUserSelectable` /
 * `statusIcon`)
 * are not part of the stable `vscode.LanguageModelChat*` typings yet. They are
 * the same shape currently consumed by GitHub Copilot Chat to render model picker
 * metadata and per-model configuration controls.
 */

export type ThinkingEffort = 'none' | 'high' | 'max';

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

interface NamedConfigurationSource {
	readonly value?: Record<string, unknown>;
}

type ThinkingEffortConfigurationSchema = ReturnType<typeof buildThinkingEffortSchema>;

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation &
	ModelCostInformation & {
		readonly isUserSelectable: boolean;
		readonly isBYOK: true;
		readonly statusIcon?: vscode.ThemeIcon;
		readonly configurationSchema?: ThinkingEffortConfigurationSchema;
	};

export function toChatInfo(
	m: ModelDefinition,
	hasApiKey: boolean,
	pricingCurrency?: PricingCurrency,
): ModelPickerChatInformation {
	const modelDetail = resolveModelText(m, 'detail') ?? m.detail;
	const modelTooltip = resolveModelText(m, 'tooltip');
	const apiKeyMissing = !hasApiKey;
	const deprecated = m.deprecated === true;
	let detail = modelDetail;
	let tooltip = modelTooltip;
	if (apiKeyMissing) {
		detail = tooltip = t('auth.apiKeyRequiredDetail');
	} else if (deprecated) {
		detail = tooltip = t('model.deprecated');
	} else if (isZenOnlyModel(m)) {
		// Go subscribers otherwise only find out via a cryptic 401 after picking.
		// The note stays in the hover `tooltip` only — surfacing it as `detail`
		// wraps the picker row (same problem the models.dev paragraph had) and
		// makes Zen rows inconsistent with the clean Go rows, so it is dropped
		// from the inline label.
		const note = t('model.zenPaygOnly');
		tooltip = tooltip ? `${tooltip}\n\n${note}` : note;
	}
	return {
		id: m.id,
		name: withOriginPrefix(m, m.name),
		family: m.family,
		version: m.version,
		detail,
		tooltip,
		statusIcon: apiKeyMissing || deprecated ? new vscode.ThemeIcon('warning') : undefined,
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isBYOK: true,
		isUserSelectable: isUserSelectableModel(m.id) && !deprecated,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
		...toModelCostInfo(m, pricingCurrency),
		...(m.capabilities.thinking ? { configurationSchema: buildThinkingEffortSchema() } : {}),
	};
}

/** @returns `false` for internal utility models so they stay out of the picker. */
function isUserSelectableModel(modelId: string): boolean {
	return modelId !== 'copilot-utility' && modelId !== 'copilot-utility-small';
}

/** Zen-only models are billed per use and are not part of the OpenCode Go subscription. */
function isZenOnlyModel(m: ModelDefinition): boolean {
	return modelOrigin(m) === 'zen';
}

/**
 * Which OpenCode plan a model routes to — `go` (subscription) or `zen`
 * (pay-as-you-go). `undefined` for models without an OpenCode endpoint pin
 * (e.g. custom models), which follow the active endpoint preset.
 */
function modelOrigin(m: ModelDefinition): 'go' | 'zen' | undefined {
	if (!m.endpointPreset) {
		return undefined;
	}
	return m.endpointPreset.startsWith('opencode-go') ? 'go' : 'zen';
}

/**
 * Prefix every OpenCode model with its billing path (`zen/DeepSeek V4 Pro`,
 * `go/GLM-5.2`) so the mixed Go+Zen catalog stays readable at a glance.
 */
function withOriginPrefix(m: ModelDefinition, name: string): string {
	const origin = modelOrigin(m);
	return origin ? `${origin}/${name}` : name;
}

export function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
	return (
		getFirstConfiguredThinkingEffort(
			{ value: options.modelConfiguration },
			{ value: options.configuration },
		) ?? 'max'
	);
}

function getFirstConfiguredThinkingEffort(
	...sources: readonly NamedConfigurationSource[]
): ThinkingEffort | undefined {
	for (const source of sources) {
		if (!source.value) {
			continue;
		}
		for (const key of [
			'reasoningEffort',
			'reasoning_effort',
			'thinkingEffort',
			'thinking_effort',
		]) {
			const effort = normalizeThinkingEffort(source.value[key]);
			if (effort) {
				return effort;
			}
		}
	}
	return undefined;
}

function normalizeThinkingEffort(value: unknown): ThinkingEffort | undefined {
	if (typeof value === 'string') {
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/[\s_]+/g, '-');
		switch (normalized) {
			case 'none':
			case 'off':
			case 'disabled':
				return 'none';
			case 'high':
			case 'standard':
			case 'balanced':
				return 'high';
			case 'max':
			case 'maximum':
			case 'deep':
			case 'xhigh':
				return 'max';
		}
	}
	return undefined;
}

function buildThinkingEffortSchema() {
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['none', 'high', 'max'],
				enumItemLabels: [t('thinking.none'), t('thinking.high'), t('thinking.max')],
				enumDescriptions: [
					t('thinking.none.desc'),
					t('thinking.high.desc'),
					t('thinking.max.desc'),
				],
				default: 'max',
				group: 'navigation',
			},
		},
	} as const;
}

function resolveModelText(m: ModelDefinition, field: 'detail' | 'tooltip'): string | undefined {
	const key = `model.${m.id}.${field}`;
	const translated = t(key);
	return translated !== key ? translated : undefined;
}
