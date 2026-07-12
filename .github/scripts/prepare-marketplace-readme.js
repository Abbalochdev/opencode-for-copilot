#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const sourcePath = process.argv[2] || 'README.md';
const outputPath = process.argv[3] || 'dist/README.marketplace.md';

// Create output directory if it doesn't exist
mkdirSync(dirname(outputPath), { recursive: true });

// Read the source file
const content = readFileSync(sourcePath, 'utf-8');
const lines = content.split('\n');

let removing = false;
let removed = 0;
const outputLines = [];

for (const line of lines) {
	if (line.includes('<!-- marketplace-readme:remove-start -->')) {
		if (removing) {
			console.error('Nested marketplace-readme remove block.');
			process.exit(1);
		}
		removing = true;
		removed += 1;
		continue;
	}

	if (line.includes('<!-- marketplace-readme:remove-end -->')) {
		if (!removing) {
			console.error('Unexpected marketplace-readme remove end marker.');
			process.exit(1);
		}
		removing = false;
		continue;
	}

	if (!removing) {
		outputLines.push(line);
	}
}

if (removing) {
	console.error('Unclosed marketplace-readme remove block.');
	process.exit(1);
}

if (removed !== 1) {
	console.error(`Expected 1 marketplace-readme remove block, found ${removed}.`);
	process.exit(1);
}

// Write the output file
writeFileSync(outputPath, outputLines.join('\n'));
