import vscode from 'vscode';
import { t } from '../../i18n';
import type { GLMMessage, GLMTool } from '../../types';
import { convertTools } from '../convert';
import { GLM_TOOLS_LIMIT, REQUEST_KINDS_ELIGIBLE_FOR_TOOL_TRIMMING } from './consts';

export function prepareRequestTools(
	toolCallingCapability: boolean | number | undefined,
	options: vscode.ProvideLanguageModelChatResponseOptions,
	preferredToolLimit?: number,
	requestKind?: string,
): GLMTool[] | undefined {
	const tools = toolCallingCapability ? convertTools(options.tools) : undefined;
	if (!tools) {
		return undefined;
	}

	const hardLimit = getToolCallingLimit(toolCallingCapability);
	const toolsCount = tools.length;

	// Tier 0: only trim for eligible request kinds; utility kinds carry ≤1 tool
	const shouldTrim = requestKind !== undefined
		&& REQUEST_KINDS_ELIGIBLE_FOR_TOOL_TRIMMING.has(requestKind);

	if (shouldTrim && preferredToolLimit !== undefined && toolsCount > preferredToolLimit) {
		// Tier 1+2: stably sort then slice to the soft cap
		return trimToolsStably(tools, preferredToolLimit);
	}

	if (toolsCount > hardLimit) {
		throw new Error(t('request.toolsLimitExceeded', hardLimit, toolsCount));
	}

	return tools;
}

/**
 * Deterministically trim tools to `limit` by alphabetical sort on the
 * function name.  Sort is stable (Array.prototype.sort is stable in V8)
 * so equal-name tools preserve their original order.
 */
function trimToolsStably(tools: GLMTool[], limit: number): GLMTool[] {
	return [...tools]
		.sort((a, b) => a.function.name.localeCompare(b.function.name))
		.slice(0, limit);
}

export function collectTrailingToolResultIds(messages: readonly GLMMessage[]): string[] {
	const trailingToolResultIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== 'tool' || !message.tool_call_id) {
			break;
		}
		trailingToolResultIds.push(message.tool_call_id);
	}
	return trailingToolResultIds.reverse();
}

function getToolCallingLimit(toolCallingCapability: boolean | number | undefined): number {
	return typeof toolCallingCapability === 'number' ? toolCallingCapability : GLM_TOOLS_LIMIT;
}
