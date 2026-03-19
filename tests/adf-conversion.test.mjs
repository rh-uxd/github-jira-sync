/**
 * Tests for Markdown ↔ ADF (Atlassian Document Format) conversion helpers.
 *
 * These functions are not exported from helpers.js, so we extract them from the
 * source and eval them into scope. This is a temporary approach until the module
 * is refactored for testability.
 *
 * Run: node tests/adf-conversion.test.mjs
 */
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

// Extract a top-level function from the source by name
function extractFn(name) {
  const re = new RegExp(`^function ${name}\\b[\\s\\S]*?\\n\\}`, 'm');
  const match = src.match(re);
  if (!match) throw new Error(`Could not find function ${name}`);
  return match[0];
}

const fnNames = [
  'adfNodeType',
  'adfInlineToMarkdown',
  'taskItemContentToMarkdown',
  'adfBlocksToMarkdown',
  'parseMarkdownInline',
  'markdownToADFBlocks',
];

const allCode = fnNames.map((n) => extractFn(n)).join('\n\n');

// Build a runner that defines all helpers in a shared scope
// randomUUID is injected via `this` since Function constructor has no module scope
function buildRunner(testBody) {
  return new Function(`const randomUUID = this.randomUUID;\n${allCode}\n\n${testBody}`);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// ─── Nested Checkboxes: GitHub → Jira ────────────────────────────────────────

console.log('\n=== Nested Checkboxes: GitHub → Jira ===');

buildRunner(`
  const md = '- [ ] Top level task\\n- [x] Completed task\\n  - [ ] Nested subtask\\n  - [x] Done subtask\\n    - [ ] Double nested\\n- [ ] Another top level';
  const blocks = markdownToADFBlocks(md);
  const root = blocks[0];

  this.assert(root.type === 'taskList', 'produces a taskList root node');
  this.assert(root.content.length === 4, 'root has 4 children (2 items + 1 nested list + 1 item)');
  this.assert(root.content[0].type === 'taskItem', 'first child is a taskItem');
  this.assert(root.content[0].attrs.state === 'TODO', 'first item is TODO');
  this.assert(root.content[1].attrs.state === 'DONE', 'second item is DONE');

  const nestedList = root.content[2];
  this.assert(nestedList.type === 'taskList', 'third child is a nested taskList');
  this.assert(nestedList.content[0].attrs.state === 'TODO', 'nested item 1 is TODO');
  this.assert(nestedList.content[1].attrs.state === 'DONE', 'nested item 2 is DONE');

  const doubleNested = nestedList.content[2];
  this.assert(doubleNested.type === 'taskList', 'double-nested taskList exists');
  this.assert(doubleNested.content[0].content[0].text === 'Double nested', 'double-nested text correct');

  this.assert(root.content[3].content[0].text === 'Another top level', 'last top-level item text correct');
`).call({ assert, randomUUID });

// ─── Nested Checkboxes: UUID localIds ────────────────────────────────────────

console.log('\n=== Nested Checkboxes: UUID localIds ===');

buildRunner(`
  const md = '- [ ] Top\\n  - [ ] Nested';
  const blocks = markdownToADFBlocks(md);
  const root = blocks[0];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  this.assert(uuidRegex.test(root.attrs.localId), 'root taskList has UUID localId: ' + root.attrs.localId);
  this.assert(uuidRegex.test(root.content[0].attrs.localId), 'taskItem has UUID localId: ' + root.content[0].attrs.localId);

  const nestedList = root.content[1];
  this.assert(uuidRegex.test(nestedList.attrs.localId), 'nested taskList has UUID localId: ' + nestedList.attrs.localId);
  this.assert(nestedList.attrs.localId !== root.attrs.localId, 'nested list localId differs from root');
`).call({ assert, randomUUID });

// ─── Nested Checkboxes: Jira → GitHub (round-trip) ──────────────────────────

console.log('\n=== Nested Checkboxes: Jira → GitHub (round-trip) ===');

buildRunner(`
  const md = '- [ ] Top level\\n  - [ ] Nested\\n    - [x] Deep nested\\n- [x] Done';
  const blocks = markdownToADFBlocks(md);
  const reversed = adfBlocksToMarkdown(blocks);
  const lines = reversed.split('\\n').filter(l => l.trim());

  this.assert(lines[0] === '- [ ] Top level', 'top-level preserved: ' + JSON.stringify(lines[0]));
  this.assert(lines[1] === '  - [ ] Nested', 'indent preserved: ' + JSON.stringify(lines[1]));
  this.assert(lines[2] === '    - [x] Deep nested', 'deep indent preserved: ' + JSON.stringify(lines[2]));
  this.assert(lines[3] === '- [x] Done', 'back to top level: ' + JSON.stringify(lines[3]));
`).call({ assert, randomUUID });

// ─── HTML <img> tag: GitHub → Jira ──────────────────────────────────────────

console.log('\n=== HTML <img> tag: GitHub → Jira ===');

buildRunner(`
  const md = '<img width="2347" height="1149" alt="Image" src="https://github.com/user-attachments/assets/example.png" />';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'mediaSingle', 'block is mediaSingle');
  this.assert(blocks[0].content[0].type === 'media', 'child is media node');
  this.assert(blocks[0].content[0].attrs.type === 'external', 'media type is external');
  this.assert(blocks[0].content[0].attrs.url === 'https://github.com/user-attachments/assets/example.png', 'URL extracted correctly');
`).call({ assert, randomUUID });

// ─── Non-self-closing <img> tag ─────────────────────────────────────────────

console.log('\n=== Non-self-closing <img> tag ===');

buildRunner(`
  const md = '<img src="https://example.com/pic.png" alt="test">';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'mediaSingle', 'block is mediaSingle');
  this.assert(blocks[0].content[0].attrs.url === 'https://example.com/pic.png', 'URL correct');
`).call({ assert, randomUUID });

// ─── Markdown image: GitHub → Jira ──────────────────────────────────────────

console.log('\n=== Markdown image ![alt](url): GitHub → Jira ===');

buildRunner(`
  const md = '![screenshot](https://example.com/image.png)';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'mediaSingle', 'block is mediaSingle');
  this.assert(blocks[0].content[0].attrs.url === 'https://example.com/image.png', 'URL correct');
`).call({ assert, randomUUID });

// ─── Image: Jira → GitHub (round-trip) ──────────────────────────────────────

console.log('\n=== Image: Jira → GitHub (round-trip) ===');

buildRunner(`
  const md = '![screenshot](https://example.com/image.png)';
  const blocks = markdownToADFBlocks(md);
  const reversed = adfBlocksToMarkdown(blocks);

  this.assert(reversed.includes('![image](https://example.com/image.png)'), 'round-trip produces markdown image: ' + JSON.stringify(reversed));
`).call({ assert, randomUUID });

// ─── Mixed content: text + img on same line ─────────────────────────────────

console.log('\n=== Mixed content: text + img ===');

buildRunner(`
  const md = 'Check this: <img src="https://example.com/pic.png" />';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 2, 'produces 2 blocks (paragraph + mediaSingle)');
  this.assert(blocks[0].type === 'paragraph', 'first block is paragraph with remaining text');
  this.assert(blocks[1].type === 'mediaSingle', 'second block is mediaSingle');
`).call({ assert, randomUUID });

// ─── Indented checkboxes don't become paragraph text ────────────────────────

console.log('\n=== Indented checkboxes not swallowed by paragraph ===');

buildRunner(`
  const md = 'Some text\\n  - [ ] indented checkbox';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 2, 'produces 2 blocks (paragraph + taskList)');
  this.assert(blocks[0].type === 'paragraph', 'first is paragraph');
  this.assert(blocks[1].type === 'taskList', 'second is taskList');
`).call({ assert, randomUUID });

// ─── HTML <details>/<summary> → ADF expand ──────────────────────────────────

console.log('\n=== HTML <details>/<summary> → ADF expand ===');

buildRunner(`
  const md = '<details>\\n<summary>Related PRs</summary>\\n\\nSome content here\\n[link](https://example.com)\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'expand', 'block is expand');
  this.assert(blocks[0].attrs.title === 'Related PRs', 'title matches summary text');
  this.assert(blocks[0].content.length > 0, 'has content blocks');
`).call({ assert, randomUUID });

// ─── Multiple <details> blocks ──────────────────────────────────────────────

console.log('\n=== Multiple <details> blocks ===');

buildRunner(`
  const md = '<details>\\n<summary>Section 1</summary>\\n\\nFirst\\n</details>\\n\\n<details>\\n<summary>Section 2</summary>\\n\\nSecond\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 2, 'produces 2 expand blocks');
  this.assert(blocks[0].type === 'expand', 'first is expand');
  this.assert(blocks[0].attrs.title === 'Section 1', 'first title correct');
  this.assert(blocks[1].type === 'expand', 'second is expand');
  this.assert(blocks[1].attrs.title === 'Section 2', 'second title correct');
`).call({ assert, randomUUID });

// ─── ADF expand → <details> round-trip ──────────────────────────────────────

console.log('\n=== ADF expand → <details> round-trip ===');

buildRunner(`
  const md = '<details>\\n<summary>Click to expand</summary>\\n\\nHidden content\\n</details>';
  const blocks = markdownToADFBlocks(md);
  const reversed = adfBlocksToMarkdown(blocks);

  this.assert(reversed.includes('<details>'), 'round-trip has <details>');
  this.assert(reversed.includes('<summary>Click to expand</summary>'), 'round-trip has summary');
  this.assert(reversed.includes('Hidden content'), 'round-trip has body content');
  this.assert(reversed.includes('</details>'), 'round-trip has </details>');
`).call({ assert, randomUUID });

// ─── HTML comments stripped ─────────────────────────────────────────────────

console.log('\n=== HTML comments stripped ===');

buildRunner(`
  const md = '<!-- This is a comment -->\\nVisible text\\n<!-- Another comment -->';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces 1 block (comment stripped)');
  this.assert(blocks[0].type === 'paragraph', 'block is paragraph');
  const text = blocks[0].content.map(n => n.text).join('');
  this.assert(!text.includes('comment'), 'comment text not in output: ' + JSON.stringify(text));
  this.assert(text.includes('Visible text'), 'visible text preserved');
`).call({ assert, randomUUID });

// ─── <details> with emoji in summary ────────────────────────────────────────

console.log('\n=== <details> with HTML tags in summary ===');

buildRunner(`
  const md = '<details>\\n<summary><sub>Check the box</sub></summary>\\n\\nContent\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks[0].type === 'expand', 'block is expand');
  this.assert(blocks[0].attrs.title === 'Check the box', 'HTML tags stripped from title');
`).call({ assert, randomUUID });

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
