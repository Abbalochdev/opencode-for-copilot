import * as vscode from 'vscode';

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
  if (curated.length > 0) {
    return curated.slice(0, MAX_TOOLS);
  }
  // Unknown tool registry (different VS Code version): cap hard, keep working.
  return [...tools].slice(0, MAX_TOOLS);
}

export function selectReadOnlyTools(
  tools: readonly vscode.LanguageModelChatTool[],
): vscode.LanguageModelChatTool[] {
  return tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name));
}
