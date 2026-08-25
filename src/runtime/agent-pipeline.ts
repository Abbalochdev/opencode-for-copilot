import vscode from 'vscode';
import {
	auditFreeModels,
	rankAuditedModels,
} from '../agents/audit-free-models';
import { formatReport, runPipeline } from '../agents/pipeline';
import { selectPipelineTools } from '../agents/tools';
import { AgentRoleConfig, FreeModelAuditEntry, ModelRef, PipelineTask } from '../agents/types';
import { getAuditFreeModelProbeMs } from '../config';
import { logger } from '../logger';
import { FREE_MODEL_REFS } from '../provider/opencode-models';
import { formatChatContext } from './chat-context';

const CONFIG_SECTION = 'opencode-for-copilot';
const AGENT_ROLES_KEY = 'agentRoles';

/** Free model used for the research pre-pass when `agentRoles.research` is unset. */
const DEFAULT_RESEARCH: ModelRef = { vendor: 'opencode', family: 'deepseek', id: 'deepseek-v4-flash-free' };
/** Free model used as reviewer when `agentRoles.review` is unset. */
const DEFAULT_REVIEW: ModelRef = { vendor: 'opencode', family: 'pickle', id: 'big-pickle' };

/**
 * Registers the agent swarm as a chat participant (`@swarm` in Copilot
 * Chat). The implementation stage runs on whatever model the user currently
 * has selected in the chat — no separate command or model picker needed.
 */
export function registerAgentPipeline(context: vscode.ExtensionContext): void {
const participant = vscode.chat.createChatParticipant(
'opencode-for-copilot.pipeline',
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

	// Audit the free-tier models once at the start of a run so `buildConfig`
	// can populate the research/review/implementFallback rotations from the
	// *actually-alive* free models instead of hardcoded defaults. Skipped
	// entirely when the user has pinned `glm-copilot.agentRoles.*` — see
	// `buildConfig`. The audit returns immediately-without-throwing on
	// cancellation, so an Esc'd run doesn't waste probe time.
	const audit = await auditFreeModels(
		FREE_MODEL_REFS,
		getAuditFreeModelProbeMs(),
		token,
	);
	const candidateRefs = rankAuditedModels(audit);

	const config = buildConfig(request.model, candidateRefs, audit);
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
		audit,
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
 * Research/review come from the `opencode-for-copilot.agentRoles` setting, defaulting
 * to free models (DeepSeek V4 Flash Free for research, Big Pickle for review).
 */
function buildConfig(
	chatModel: vscode.LanguageModelChat,
	candidateRefs: readonly ModelRef[],
	audit: readonly FreeModelAuditEntry[],
): AgentRoleConfig {
	const pinned = parseAgentRoleConfig(
		vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>(AGENT_ROLES_KEY),
	);
	// When the user pinned *anything* in agentRoles.*, trust them entirely.
	// The audit was still run (so the report shows current free-tier health),
	// but the rotation comes from their pinned list — audit doesn't override
	// user intent.
	if (pinned) {
		return {
			research: pinned.research ?? [DEFAULT_RESEARCH],
			implement: { vendor: chatModel.vendor, family: chatModel.family, id: chatModel.id },
			...(pinned.review ? { review: pinned.review } : {}),
			...(pinned.implementFallback ? { implementFallback: pinned.implementFallback } : {}),
		};
	}
	// Unpinned: route through audited refs. When none responded, fall back to
	// the historical hardcoded default so the run still proceeds (with a
	// visible "all audited models failed" caveat in the report rather than a
	// hard abort — the user gets to see the failure + reason). Mutate from the
	// readonly input by spreading into a fresh array — `AgentRoleConfig`'s
	// fields are typed as mutable `ModelRef[]`, so a `readonly` array can't
	// be assigned directly without this copy.
	const refs: ModelRef[] =
		candidateRefs.length > 0 ? [...candidateRefs] : [DEFAULT_RESEARCH];
	return {
		research: refs,
		implement: { vendor: chatModel.vendor, family: chatModel.family, id: chatModel.id },
		review: refs,
		implementFallback: refs,
	};
}

function parseAgentRoleConfig(
	raw: unknown,
): { research?: ModelRef[]; review?: ModelRef[]; implementFallback?: ModelRef[] } | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const research = parseModelRefs(obj.research);
	const review = parseModelRefs(obj.review);
	const implementFallback = parseModelRefs(obj.implementFallback);
	if (research.length === 0 && review.length === 0 && implementFallback.length === 0) {
		return undefined;
	}
	return {
		...(research.length > 0 ? { research } : {}),
		...(review.length > 0 ? { review } : {}),
		...(implementFallback.length > 0 ? { implementFallback } : {}),
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
