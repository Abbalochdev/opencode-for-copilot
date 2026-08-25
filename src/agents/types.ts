/** A model reference resolved from `opencode-for-copilot.agentRoles` settings. */
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
	/**
	 * Optional fallback models tried in order after the chat-selected
	 * `implement` model throws "no model found" (or other permanent
	 * unavailability). Default in {@link buildConfig} is the audited free
	 * models — so out-of-the-box users get a safety net with zero config.
	 */
	implementFallback?: ModelRef[];
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
	/**
	 * Free-model audit results. Present only when the audit was actually run
	 * (i.e. `agentRoles.*` was NOT pinned by the user — user-override mode
	 * skips the audit). Rendered by {@link formatReport} as a table at the
	 * bottom of the @swarm report so users see *which* free models were alive
	 * and which were skipped (this is the diagnostic the user-facing
	 * "research agent failed" message replaced). Empty when there is nothing
	 * to surface, which keeps the report quiet on the audit-skip path.
	 */
	auditReport?: FreeModelAuditEntry[];
	/**
	 * Optional: free-model fallback chain actually used to back the
	 * implementer. Surfaced in {@link formatReport} only when an implementer
	 * fell back — so the report stays quiet when the chat-selected model was
	 * healthy and no fallback was needed. Empty array = "audit ran, nothing
	 * triaged" (also quiet).
	 */
	implementFallbackUsed?: ModelRef[];
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

/**
 * One free model's audit result.)
 *
 * Defined here (not in `audit-free-models.ts`) so {@link PipelineResult} can
 * reference it without importing a runtime module — keeps `types.ts` a pure
 * type surface. The runtime auditor (`auditOneFreeModel`) produces these.
 */
export interface FreeModelAuditEntry {
	/** The model that was probed. */
	ref: ModelRef;
	/** Whether a probe call completed without error. */
	ok: boolean;
	/**
	 * Round-trip latency of the probe in ms. Defined only when `ok` is true.
	 * Stable-sorted ascending by this value by {@link rankAuditedModels}.
	 */
	latencyMs?: number;
	/**
	 * Short error class string when `ok` is false (`"no model found"`,
	 * `"transient"`, `"timeout"`, `"cancelled"`, `"other"`). Surfaced in the
	 * @swarm report so the user can see *why* a model was skipped.
	 */
	errorClass?: string;
	/** The underlying error message — kept for log diagnostics, not the report. */
	errorMessage?: string;
}
