/** A model reference resolved from `glm-copilot.agentRoles` settings. */
export interface ModelRef {
	vendor: string;
	family: string;
	id?: string;
}

/** Models assigned to each pipeline stage. */
export interface AgentRoleConfig {
	/** Models used for the parallel research step (round-robin). */
	research: ModelRef[];
	/** Model used for implementation — always the chat model the user picked. */
	implement: ModelRef;
	/** Optional models used for the pre-implementation review step. */
	review?: ModelRef[];
}

/** A task handed to the pipeline by the chat participant. */
export interface PipelineTask {
  id: string;
  /**
   * The user's task description (Copilot's `ChatRequest.prompt`, trimmed).
   * Used both as the user instruction to the sub-agents AND as a research-area
   * label, so don't pollute it with attached-context text — put that in
   * {@link contextPreamble} instead.
   */
  description: string;
  workspaceRoot: string;
  /**
   * Optional chat-context preamble (attached @-references: files, folders,
   * selection, URLs; resolved via Copilot's `ChatRequest.references`).
   *
   * When non-empty, every sub-agent user prompt prepends this block so the
   * swarm actually sees the files/selection the user attached. By default it
   * is empty, so the prompt shape is unchanged for users who attach nothing.
   */
  contextPreamble?: string;
}

/** One parallel research area's condensed findings. */
export interface ResearchFinding {
	area: string;
	summary: string;
	relevantFiles: string[];
}

/** Outcome of the pre-implementation review stage. */
export interface ReviewResult {
	verdict: 'ok' | 'issues';
	notes: string;
}

/** Final pipeline report. */
export interface PipelineResult {
	diffSummary: string;
	testsPassed: boolean;
	/** Whether the implementation agent actually invoked the test tool. */
	ranTests: boolean;
	turns: number;
	researchAreas: number;
	reviewNote?: string;
	/** Estimated token usage across all stages — input + output. */
	cost: PipelineCost;
}

/** Token usage estimate across a pipeline run, broken down by stage. */
export interface PipelineCost {
	/** Total estimated input tokens sent to all models. */
	inputTokens: number;
	/** Total estimated output tokens produced by all models. */
	outputTokens: number;
	/** Number of model requests made. */
	requests: number;
}
