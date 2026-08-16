import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { selectPipelineTools, selectReadOnlyTools } from '../../src/agents/tools';
import { __clearConfigurationValues, __setConfigurationValue } from '../support/vscode.mock';

function tool(name: string): vscode.LanguageModelChatTool {
	return {
		name,
		description: `${name} description`,
		inputSchema: { type: 'object' },
	} as vscode.LanguageModelChatTool;
}

// A representative curated built-in tool name from the whitelist.
const KNOWN_PIPELINE = 'read_file';
const KNOWN_MUTATOR = 'apply_patch';
const KNOWN_READONLY = 'grep_search';

describe('selectPipelineTools (allowExtraTools)', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('returns only curated tools by default (whitelist enforced)', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', false);
		const out = selectPipelineTools([
			tool(KNOWN_PIPELINE),
			tool('mcp_sqlite_query'),
			tool('mcp_browser_navigate'),
		]);
		expect(out.map((t) => t.name)).toEqual([KNOWN_PIPELINE]);
	});

	it('appends extra tools when allowExtraTools is on, curated first', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', true);
		const out = selectPipelineTools([
			tool('mcp_browser_navigate'),
			tool(KNOWN_MUTATOR),
			tool('mcp_sqlite_query'),
		]);
		// curated before extras — preserves priority when the cap kicks in.
		expect(out.map((t) => t.name)).toEqual([KNOWN_MUTATOR, 'mcp_browser_navigate', 'mcp_sqlite_query']);
	});

	it('still enforces the 128-tool hard cap after pass-through', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', true);
		// Curated set has ~25 entries; padding with enough known-names to verify
		// the slice applies AFTER merging curated + extras (not before).
		const curatedNames = [
			'apply_patch',
			'insert_edit_into_file',
			'create_file',
			'replace_string_in_file',
			'multi_replace_string_in_file',
		];
		const extras = Array.from({ length: 200 }, (_, i) => `mcp_extra_${i}`);
		const all = [...curatedNames, ...extras].map(tool);
		const out = selectPipelineTools(all);
		// MAX_TOOLS = 100 (the project's conservative cap, broader than GLM's 128).
		expect(out).toHaveLength(100);
		// Curated tools always survive the cap before extras.
		expect(out.slice(0, curatedNames.length).map((t) => t.name)).toEqual(curatedNames);
		// Nothing leaks beyond the cap — index 100 is the first out-of-bounds slot.
		expect(out[100]).toBeUndefined();
	});

	it('keeps the curated whitelist behavior when allowExtraTools is on but only curated tools exist', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', true);
		const out = selectPipelineTools([tool(KNOWN_PIPELINE), tool(KNOWN_MUTATOR)]);
		expect(out.map((t) => t.name).sort()).toEqual([KNOWN_MUTATOR, KNOWN_PIPELINE]);
	});
});

describe('selectReadOnlyTools (allowExtraTools)', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('returns only curated read-only tools by default', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', false);
		const out = selectReadOnlyTools([
			tool(KNOWN_READONLY),
			tool('mcp_sqlite_query'),
			tool(KNOWN_MUTATOR),
		]);
		expect(out.map((t) => t.name)).toEqual([KNOWN_READONLY]);
	});

	it('adds read-only extras (query/read/search) when allowExtraTools is on', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', true);
		const out = selectReadOnlyTools([
			tool(KNOWN_READONLY),
			tool('mcp_sqlite_query'), // contains "query"
			tool('mcp_github_search_issues'), // contains "search"
			tool('mcp_browser_navigate'), // no read-only verb → excluded
			tool(KNOWN_MUTATOR), // curated mutator → excluded from read-only pool
		]);
		expect(out.map((t) => t.name)).toEqual([
			KNOWN_READONLY,
			'mcp_sqlite_query',
			'mcp_github_search_issues',
		]);
	});

	it('does NOT auto-promote mutators into the read-only pool even with pass-through', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', true);
		const out = selectReadOnlyTools([
			tool('mcp_browser_click'), // not in read-only verbs
			tool('mcp_db_write_row'),
		]);
		expect(out).toEqual([]);
	});

	it('read-only name heuristic is case-insensitive', () => {
		__setConfigurationValue('glm-copilot.allowExtraTools', true);
		const out = selectReadOnlyTools([tool('MCP_Graphics_FETCH')]);
		expect(out.map((t) => t.name)).toEqual(['MCP_Graphics_FETCH']);
	});
});
