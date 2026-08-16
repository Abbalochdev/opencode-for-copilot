import vscode from 'vscode';
import { formatReport, runPipeline } from '../agents/pipeline';
import { selectPipelineTools } from '../agents/tools';
import { AgentRoleConfig, ModelRef, PipelineTask } from '../agents/types';
import { logger } from '../logger';
import { formatChatContext } from './chat-context';

const CONFIG_SECTION = 'glm-copilot';
const AGENT_ROLES_KEY = 'agentRoles';

/** Free model used for the research pre-pass when `agentRoles.research` is unset. */
const DEFAULT_RESEARCH: ModelRef = { vendor: 'glm', family: 'deepseek', id: 'deepseek-v4-flash-free' };
/** Free model used as reviewer when `agentRoles.review` is unset. */
const DEFAULT_REVIEW: ModelRef = { vendor: 'glm', family: 'pickle', id: 'big-pickle' };

/**
 * Registers the agent swarm as a chat participant (`@swarm` in Copilot
 * Chat). The implementation stage runs on whatever model the user currently
 * has selected in the chat — no separate command or model picker needed.
 */
export function registerAgentPipeline(context: vscode.ExtensionContext): void {
const participant = vscode.chat.createChatParticipant(
'glm-copilot.pipeline',
async (request, _chatContext, response, token) => {
try {
await runPipelineInChat(request, response, token);
} catch (error) {
logger.error('Agent swarm failed', error);
response.markdown(
`**Agent swarm failed:** ${error instanceof Error ? error.message : String(error)}`,
);
}
},
);
context.subscriptions.push(participant);
}

async function runPipelineInChat(
request: vscode.ChatRequest,
response: vscode.ChatResponseStream,
token: vscode.CancellationToken,
): Promise<void> {
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
if (!workspaceRoot) {
response.markdown('Open a workspace folder before running the agent swarm.');
return;
}

const description = request.prompt.trim();
if (!description) {
response.markdown('Describe the task for the agent swarm.');
return;
}

	// Surface attached chat context (@-references: pinned files/folders, URLs,
	// symbol ranges) and the active editor selection so the swarm actually
	// receives what the user attached. Pre-3.x the swarm silently dropped
	// these. We resolve Uri / Location fsPaths to workspace-relative paths to
	// keep prompts short and to match the agent's existing workspace-relative
	// tool inputs (`read_file`, `list_dir`, …).
	const selectionUris = resolveSelectionUris();
	const preamble = formatChatContext(request.references, selectionUris);

	const config = buildConfig(request.model);
	const task: PipelineTask = {
		id: String(Date.now()),
		description,
		workspaceRoot,
		...(preamble ? { contextPreamble: preamble } : {}),
	};

	const progress: vscode.Progress<{ message: string }> = {
		report: (p) => response.progress(p.message),
	};

	const result = await runPipeline(
		task,
		config,
		selectPipelineTools(vscode.lm.tools),
		token,
		progress,
		request.toolInvocationToken,
	);

	response.markdown(formatReport(result));
}

/**
 * Resolve the active editor's selection (if any) to a workspace-relative
 * path. Returns `[]` when nothing useful is selected, mirroring the no-op
 * baseline of "no attached context". Kept as a separate function so the
 * side-effecting `vscode.window.*` lookup stays out of the pure formatter
 * and out of `runPipelineInChat`'s synchronous body.
 */
function resolveSelectionUris(): string[] {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		return [];
	}
	try {
		const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
		return [relative];
	} catch {
		return [];
	}
}

/**
 * Implementation always runs on the model the user selected in the chat.
 * Research/review come from the `glm-copilot.agentRoles` setting, defaulting
 * to free models (DeepSeek V4 Flash Free for research, Big Pickle for review).
 */
function buildConfig(chatModel: vscode.LanguageModelChat): AgentRoleConfig {
const fromSettings = parseAgentRoleConfig(
vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(AGENT_ROLES_KEY),
);
return {
research: fromSettings?.research ?? [DEFAULT_RESEARCH],
implement: { vendor: chatModel.vendor, family: chatModel.family, id: chatModel.id },
review: fromSettings?.review ?? [DEFAULT_REVIEW],
};
}

function parseAgentRoleConfig(raw: unknown): { research?: ModelRef[]; review?: ModelRef[] } | undefined {
if (typeof raw !== 'object' || raw === null) {
return undefined;
}
const obj = raw as Record<string, unknown>;
const research = parseModelRefs(obj.research);
const review = parseModelRefs(obj.review);
if (research.length === 0 && review.length === 0) {
return undefined;
}
return {
...(research.length > 0 ? { research } : {}),
...(review.length > 0 ? { review } : {}),
};
}

function parseModelRefs(value: unknown): ModelRef[] {
if (!Array.isArray(value)) {
return [];
}
return value
.map(parseModelRef)
.filter((ref): ref is ModelRef => ref !== undefined);
}

function parseModelRef(value: unknown): ModelRef | undefined {
if (typeof value !== 'object' || value === null) {
return undefined;
}
const ref = value as Record<string, unknown>;
if (typeof ref.vendor !== 'string' || typeof ref.family !== 'string') {
return undefined;
}
return {
vendor: ref.vendor,
family: ref.family,
...(typeof ref.id === 'string' ? { id: ref.id } : {}),
};
}
