import * as vscode from 'vscode';
import { estimateTokenCount } from '../provider/tokens';

/**
 * Accumulates estimated token usage across a pipeline run.
 *
 * C2 from the validation report: the swarm discards the token counts it
 * sends/receives, so there's no visibility into cost. This wraps the model
 * call to count input messages before sending and output text after streaming,
 * using the existing `estimateTokenCount` estimator. Estimates, not exact —
 * the VS Code API doesn't expose real usage from `sendRequest`.
 */
export class PipelineCostTracker {
	private inputTokens = 0;
	private outputTokens = 0;
	private requests = 0;

	/** Count input tokens from the messages array before a request. */
	countInput(messages: readonly vscode.LanguageModelChatMessage[]): void {
		this.requests++;
		for (const message of messages) {
			this.inputTokens += estimateTokenCount(message, 4);
		}
	}

	/** Count output tokens from the streamed text parts after a response. */
	countOutput(textLength: number): void {
		// Latin-heavy heuristic (~4 chars/token) matches the estimator's default.
		this.outputTokens += Math.max(1, Math.ceil((textLength || 0) / 4));
	}

	/** Returns the collected cost summary. */
	build(): { inputTokens: number; outputTokens: number; requests: number } {
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			requests: this.requests,
		};
	}
}