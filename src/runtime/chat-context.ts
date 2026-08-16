import type * as vscode from 'vscode';

/**
 * Build a plain-text preamble from the {@link vscode.ChatRequest.references}
 * and any active editor selection, so the agent swarm actually sees the
 * context the user attached in Copilot Chat. The returned string is intended
 * for {@link PipelineTask.contextPreamble} — every sub-agent prepends it to
 * its user prompt (see {@link joinTaskPrompt} in `src/agents/loop.ts`).
 *
 * Reference values come as `string | Uri | Location | unknown`; we coerce the
 * shapes the docs document (the `unknown` catch-all is preserved verbatim
 * when the reference carries a `modelDescription`). Unknown reference kinds
 * are dropped rather than stringified — the previous swarm behaviour (no
 * attached context at all) is unchanged when the user attaches nothing we
 * recognise. References are already returned in reverse-prompt order by VS
 * Code, so we keep that order to mirror the user's mental model.
 *
 * Pure (no I/O, no side effects, no Copilot API calls); the only integrations
 * needed are an active-text-editor lookup (passed in by the caller) and a
 * `fsPath`-style workspace-relative path resolver (`stringifyRef`, also passed
 * in by the caller) so the runtime can use VS Code's real
 * `workspace.asRelativePath` while tests can inject a stub.
 *
 * Returns `''` when there is nothing to surface — the pipeline treats the
 * empty preamble as a no-op and the historical prompt shape is preserved.
 */
export function formatChatContext(
	references: readonly vscode.ChatPromptReference[],
	selectionUris: readonly string[],
): string {
	const lines: string[] = [];

	for (const ref of references) {
		const line = describeReference(ref);
		if (line) {
			lines.push(line);
		}
	}

	for (const uri of selectionUris) {
		if (uri) {
			lines.push(`- Current selection: ${uri}`);
		}
	}

	return lines.join('\n');
}

/**
 * Resolve one reference to a one-line description fit for a prompt. Returns
 * `undefined`/`''` for references we don't know how to surface so they are
 * skipped (matches VS Code's existing "up to the participant" guidance).
 */
function describeReference(ref: vscode.ChatPromptReference): string | undefined {
	const value = ref.value;
	const label = ref.modelDescription?.trim();

	// `string` references — used for inline values like `#something` text. Use
	// the reference's description when present; fall back to the raw string.
	if (typeof value === 'string') {
		return `- ${label ?? value}`;
	}

	// `Uri` / { fsPath: string } — files / folders the user pinned with `#file`
	// or `#folder`. fsPath is typically absolute; the runtime rewrites via
	// `asRelativePath` (see the agent-pipeline caller) before reaching here we
	// trust the caller's pre-resolution and just describe what arrives.
	const fsPath = (value as { fsPath?: string } | null)?.fsPath;
	if (typeof fsPath === 'string' && fsPath.length > 0) {
		return `- ${label ?? fsPath}`;
	}

	// `Location` — a `{ uri, range }` reference. Use the uri's fsPath.
	const locationUri = (value as { uri?: { fsPath?: string } } | null)?.uri?.fsPath;
	if (typeof locationUri === 'string' && locationUri.length > 0) {
		return `- ${label ?? locationUri}`;
	}

	// Unknown / future reference shapes — don't stringify arbitrarily; that
	// risks dumping `[object Object]` into the prompt. Drop silently (matches
	// the prior behaviour of "no attached context").
	return undefined;
}

/**
 * Pick the URIs (as workspace-relative strings) of the active editor's
 * selection, if any. Extracted from {@link formatChatContext} so the runtime
 * caller owns the editor lookup — keeps the formatter pure and testable.
 *
 * Returns `[]` when nothing useful is selected, mirroring the "no attached
 * context" baseline.
 */
export function selectionToRelativeUris(
	editor: { selection?: { isEmpty?: boolean } } | undefined,
	relativePath: string | undefined,
): string[] {
	if (!editor?.selection || editor.selection.isEmpty || !relativePath) {
		return [];
	}
	return [relativePath];
}
