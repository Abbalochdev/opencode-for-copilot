import * as vscode from 'vscode';
import type { ModelRef } from './types';

/**
 * Per-run model cache — a pipeline run resolves the same `ModelRef` multiple
 * times (decomposition + each research area + each reviewer). The cache
 * collapses those to one `selectChatModels` call per distinct ref.
 * Cleared per run via `clearModelCache`.
 */
const modelCache = new Map<string, vscode.LanguageModelChat>();

function modelCacheKey(ref: ModelRef): string {
	return `${ref.vendor}::${ref.family}::${ref.id ?? ''}`;
}

/** Clears the per-run model cache — call at the start of each pipeline run. */
export function clearModelCache(): void {
	modelCache.clear();
}

/**
 * Selects a specific model programmatically, independent of whatever the
 * user currently has picked in the Copilot Chat model picker. This is the
 * mechanism that lets different pipeline stages run on different models
 * in the same run. Results are cached per distinct `ModelRef` so the swarm's
 * repeated lookups (decompose + each research area + each reviewer) resolve
 * one `selectChatModels` call each.
 */
export async function pickModel(ref: ModelRef): Promise<vscode.LanguageModelChat> {
	const key = modelCacheKey(ref);
	const cached = modelCache.get(key);
	if (cached) {
		return cached;
	}
	const models = ref.id
		? await vscode.lm.selectChatModels({ vendor: ref.vendor, id: ref.id })
		: await vscode.lm.selectChatModels({ vendor: ref.vendor, family: ref.family });
	if (models.length === 0) {
		throw new Error(
			`No model found for vendor="${ref.vendor}" family="${ref.family}"${ref.id ? ` id="${ref.id}"` : ''}. `
			+ 'Check glm-copilot.modelIdOverrides for the exact id string this model registers under.',
		);
	}
	const model = models[0];
	modelCache.set(key, model);
	return model;
}

/** Text parts of a tool result — everything else (tsx, data) is dropped. */
export function resultToTextParts(result: vscode.LanguageModelToolResult): vscode.LanguageModelTextPart[] {
	return result.content.filter(
		(part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart,
	);
}

/** Flat text of a tool result. */
export function resultToText(result: vscode.LanguageModelToolResult): string {
	return resultToTextParts(result).map((part) => part.value).join('\n');
}
