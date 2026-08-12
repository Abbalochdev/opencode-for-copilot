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
	description: string;
	workspaceRoot: string;
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
}
