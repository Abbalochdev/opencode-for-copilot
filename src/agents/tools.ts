import * as vscode from 'vscode';
import { getAllowExtraTools } from '../config';

/**
 * GLM hard-caps the `tools` array at 128 entries. Copilot registers more
 * than that (151 at last count), so we must curate — passing everything
 * makes GLM reject the whole request.
 */
const MAX_TOOLS = 100;

/** Read-only tools a research agent may use. */
const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'grep_search',
  'list_dir',
  'file_search',
  'semantic_search',
  'search_workspace_symbols',
  'read_project_structure',
  'get_errors',
  'get_changed_files',
  'test_search',
]);

/** Everything the pipeline may pass to the model: research + edits + terminal/tests. */
const PIPELINE_TOOL_NAMES = new Set([
  ...READ_ONLY_TOOL_NAMES,
  'apply_patch',
  'insert_edit_into_file',
  'create_file',
  'replace_string_in_file',
  'multi_replace_string_in_file',
  'create_directory',
  'edit_notebook_file',
  'run_in_terminal',
  'get_terminal_output',
  'send_to_terminal',
  'create_and_run_task',
  'run_task',
  'get_task_output',
  'runTests',
  'testFailure',
]);

export function selectPipelineTools(
  tools: readonly vscode.LanguageModelChatTool[],
): vscode.LanguageModelChatTool[] {
  const curated = tools.filter((tool) => PIPELINE_TOOL_NAMES.has(tool.name));
  if (curated.length > 0 && !getAllowExtraTools()) {
    return curated.slice(0, MAX_TOOLS);
  }
  // Either: curated whitelist is empty (unknown VS Code tool registry — keep
  // working with whatever we got), or the user has opted into passing extra
  // tools through (MCP-discovered tools and other Copilot-registered external
  // tools). In both cases preserve the GLM request cap and keep the curated
  // whitelist first so core research/implement tools survive the cap before
  // any extras. When curated is non-empty and pass-through is on, extras are
  // appended after the curated set so the curated tools always get a slot.
  const extras = getAllowExtraTools()
    ? tools.filter((tool) => !PIPELINE_TOOL_NAMES.has(tool.name))
    : [];
  return [...curated, ...extras].slice(0, MAX_TOOLS);
}

export function selectReadOnlyTools(
  tools: readonly vscode.LanguageModelChatTool[],
): vscode.LanguageModelChatTool[] {
  const curated = tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name));
  if (!getAllowExtraTools()) {
    return curated;
  }
  // Opt-in pass-through: include read-only tools Copilot registers that we do
  // not know by name (e.g. MCP `*_search` / `*_read` probes). We can't tell
  // from {@link LanguageModelChatTool} alone whether an unknown tool is
  // read-only, so keep the conservative behaviour of NOT auto-promoting
  // unknown mutators into the read-only research/review pool. Only the
  // implementer (via {@link selectPipelineTools}) gets the full extras set.
  const extras = tools.filter((tool) => !PIPELINE_TOOL_NAMES.has(tool.name) && isReadOnlyByName(tool));
  return [...curated, ...extras];
}

/**
 * Heuristic: guess whether a pass-through tool the whitelist doesn't know is
 * safe for the read-only research/review pool. We only allow names whose
 * verbs read as clearly non-mutating: `read`, `query`, `search`, `list`,
 * `fetch`, `get`, `resolve`, `describe`. Anything that could *write* is
 * excluded from the read-only pool and remains available only to the
 * implementer pool (which is allowed to mutate).
 *
 * `lazy:` heuristic — name patterns, not capabilities. Ceiling: a tool that
 * reads but is named `runTests` would not be classified read-only. Upgrade
 * path: when {@link LanguageModelToolInformation} exposes a real `readonly`
 * signal (or Copilot adopts MCP-discovered read-only tagging), key off that
 * instead of the tool name.
 */
function isReadOnlyByName(tool: vscode.LanguageModelChatTool): boolean {
  const name = tool.name.toLowerCase();
  if (READ_ONLY_NAME_VERBS.some((verb) => name.includes(verb))) {
    return true;
  }
  return false;
}

/** Verbs (substrings) that indicate a tool is read-only by name. */
const READ_ONLY_NAME_VERBS = ['read', 'query', 'search', 'list', 'fetch', 'get', 'resolve', 'describe'];
