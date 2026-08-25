import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { formatChatContext, selectionToRelativeUris } from '../../src/runtime/chat-context';

function ref(
	value: unknown,
	modelDescription?: string,
): vscode.ChatPromptReference {
	return {
		id: 'test',
		value,
		...(modelDescription ? { modelDescription } : {}),
	} as vscode.ChatPromptReference;
}

function uriRef(fsPath: string, label?: string): vscode.ChatPromptReference {
	return ref({ fsPath, $mid: 1, path: fsPath, scheme: 'file' } as unknown, label);
}

function locationRef(fsPath: string, label?: string): vscode.ChatPromptReference {
	return ref({ uri: { fsPath, scheme: 'file' } }, label);
}

describe('formatChatContext', () => {
	it('returns empty string when there are no references and no selection', () => {
		expect(formatChatContext([], [])).toBe('');
	});

	it('uses modelDescription when the reference value is a plain string', () => {
		const out = formatChatContext([ref('some-id', 'Pinned string: my-file.ts')], []);
		expect(out).toContain('Pinned string: my-file.ts');
		expect(out).not.toContain('some-id'); // description wins over raw value
	});

	it('falls back to the raw string when no description is given', () => {
		expect(formatChatContext([ref('some-url')], [])).toBe('- some-url');
	});

	it('surfaces Uri references by fsPath', () => {
		const out = formatChatContext([uriRef('src/index.ts')], []);
		expect(out).toBe('- src/index.ts');
	});

	it('uses modelDescription over fsPath when both are present for Uri refs', () => {
		const out = formatChatContext([uriRef('src/index.ts', 'Current file')], []);
		expect(out).toBe('- Current file');
	});

	it('surfaces Location references by fsPath of the uri', () => {
		expect(formatChatContext([locationRef('src/lib/utils.ts')], [])).toBe(
			'- src/lib/utils.ts',
		);
	});

	it('drops unknown reference kinds instead of stringifying objects', () => {
		const out = formatChatContext([ref({ kind: 7 })], []);
		expect(out).toBe('');
	});

	it('keeps references in the order provided (reverse-prompt order)', () => {
		const out = formatChatContext([uriRef('a.ts'), uriRef('b.ts'), ref('hi')], []);
		expect(out).toBe('- a.ts\n- b.ts\n- hi');
	});

	it('combines references and selection URIs (references first)', () => {
		const out = formatChatContext([uriRef('x.ts')], ['src/editor.ts']);
		expect(out).toBe('- x.ts\n- Current selection: src/editor.ts');
	});

	it('skips empty selection URIs', () => {
		expect(formatChatContext([], [''])).toBe('');
	});
});

describe('selectionToRelativeUris', () => {
	it('returns [] when there is no editor', () => {
		expect(selectionToRelativeUris(undefined, 'src/x.ts')).toEqual([]);
	});

	it('returns [] when the editor selection is empty', () => {
		expect(
			selectionToRelativeUris({ selection: { isEmpty: true } }, 'src/x.ts'),
		).toEqual([]);
	});

	it('returns [] when there is a selection but no relative path', () => {
		expect(
			selectionToRelativeUris({ selection: { isEmpty: false } }, undefined),
		).toEqual([]);
	});

	it('returns [relativePath] when there is a non-empty selection and a relative path', () => {
		expect(
			selectionToRelativeUris({ selection: { isEmpty: false } }, 'src/foo.ts'),
		).toEqual(['src/foo.ts']);
	});
});
