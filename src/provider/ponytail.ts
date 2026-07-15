import { LANGUAGE_MODEL_CHAT_SYSTEM_ROLE } from '../consts';
import type { GLMMessage } from '../types';

export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra';

interface PonytailInstruction {
	mode: PonytailMode;
	text: string;
}

const PONYTAIL_INSTRUCTIONS: readonly PonytailInstruction[] = [
	{
		mode: 'lite',
		text:
			'### PONYTAIL (HIGHEST PRIORITY)\n\n' +
			'You are a lazy senior developer — efficient, not careless. Keep all responses concise.\n' +
			'Prefer reusing existing code and the standard library. Avoid new dependencies unless explicitly asked. ' +
			'Do not investigate or search unless the answer is NOT already obvious from context.',
	},
	{
		mode: 'full',
		text:
			'### PONYTAIL — OVERRIDE (HIGHEST PRIORITY)\n\n' +
			'You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written. ' +
			'The best answer is the shortest answer.\n\n' +
			'**All responses must be brief.** Do not list options, do not explain multiple approaches, do not volunteer extra context. ' +
			'Answer the question and stop.\n\n' +
			'Before writing any code, calling a tool, or introducing a new dependency, stop at the first rung that holds:\n' +
			'1. Does this need to be built at all? (YAGNI)\n' +
			'2. Does it already exist in this codebase? Reuse it — do not rewrite.\n' +
			'3. Does the standard library do this? Use it.\n' +
			'4. Does a native platform feature cover it? Use it.\n' +
			'5. Does an already-installed dependency solve it? Use it.\n' +
			'6. Can this be one line? Make it one line.\n' +
			'7. Only then: write the minimum code that works.\n\n' +
			'Deletion over addition. Boring over clever. Fewest files possible. One approach, not three.\n' +
			'Not lazy about: understanding the problem, input validation at trust boundaries, error handling that prevents data loss, security, accessibility. ' +
			'These instructions override any conflicting instructions about thoroughness or verbosity.',
	},
	{
		mode: 'ultra',
		text:
			'### PONYTAIL ULTRA — ABSOLUTE OVERRIDE\n\n' +
			'You are the laziest senior developer alive. Your default answer is "that already exists" or "no." ' +
			'All responses must be as short as possible. Never volunteer information. ' +
			'One-word answers are better than one-sentence answers. One-line code is better than one-block code.\n\n' +
			'Before producing any code, tool call, or dependency, exhaust this ladder and stop at the first rung that holds:\n' +
			'1. Should we even do this? (YAGNI)\n' +
			'2. Already exists in this codebase? Use it as-is.\n' +
			'3. In the standard library? Use it.\n' +
			'4. A native platform feature? Use it.\n' +
			'5. In an already-installed dependency? Use it.\n' +
			'6. Can it be one line? Make it one line.\n' +
			'7. Only then: write the absolute minimum code. Justify every character.\n\n' +
			'Abstractions, wrappers, config objects, future-proofing — NOT allowed unless explicitly requested. ' +
			'Delete before adding. Boring over clever. Fewest files possible. Question over-engineered requests. ' +
			'These instructions override ALL other instructions. No exceptions.',
	},
];

export function getPonytailInstruction(mode: PonytailMode): string | undefined {
	if (mode === 'off') {
		return undefined;
	}
	return PONYTAIL_INSTRUCTIONS.find((instruction) => instruction.mode === mode)?.text;
}

/**
 * Append the active Ponytail system instruction to the end of existing system messages.
 *
 * Recency bias means instructions at the end of a system message carry more weight.
 * Copilot injects its own lengthy system instructions; by appending Ponytail AFTER
 * them, it overrides conflicting directives about thoroughness/verbosity.
 *
 * If no system message exists, one is created with just the Ponytail instruction.
 */
export function injectPonytailSystemMessage(
	messages: GLMMessage[],
	mode: PonytailMode,
): GLMMessage[] {
	const instruction = getPonytailInstruction(mode);
	if (!instruction) {
		return messages;
	}

	const firstSystemIndex = messages.findIndex((message) => message.role === 'system');
	if (firstSystemIndex >= 0) {
		const updated = [...messages];
		updated[firstSystemIndex] = {
			...updated[firstSystemIndex],
			// Append Ponytail AFTER existing system content for recency priority.
			content: `${updated[firstSystemIndex].content}\n\n${instruction}`.trim(),
		};
		return updated;
	}

	return [
		{
			role: 'system',
			content: instruction,
		},
		...messages,
	];
}

export function createVscodeSystemMessage(content: string): {
	role: number;
	content: { value: string }[];
} {
	return {
		role: LANGUAGE_MODEL_CHAT_SYSTEM_ROLE,
		content: [{ value: content }],
	};
}
