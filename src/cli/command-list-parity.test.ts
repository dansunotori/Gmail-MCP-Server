import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './commands.js';

// A new command is listed in COMMANDS, package.json's bin, its src/cli/gmail-*.ts entry file,
// the README's command table and the spec's bin table, and counted in both texts; these tests
// keep those in step with COMMANDS.

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(cliDir, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const README = read('README.md');
const SPEC = read('docs/gmail-cli-spec.md');

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

// "command tool" for each row of the Markdown table under `header`: the command is the first word
// of the first cell's code span, the tool the second cell's code span. Cells split at a pipe not
// escaped as \|.
function tableRows(markdown: string, header: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
    const command = cells[0]?.match(/^`([^`\s]+)/)?.[1];
    const tool = cells[1]?.match(/^`([^`]+)`$/)?.[1];
    rows.push(`${command} ${tool}`);
  }
  return rows.sort();
}

// The number each pattern's first group spells, as a word ("Nine" is 9), or NaN.
const counts = (text: string, patterns: RegExp[]) =>
  patterns.flatMap(pattern => {
    const match = text.match(pattern);
    return match ? match.slice(1).map(word => NUMBER_WORDS.indexOf(word.toLowerCase())) : [Number.NaN];
  }).map(count => (count === -1 ? Number.NaN : count));

const README_TABLE = '| Command | MCP tool | Prints |';
const SPEC_TABLE = '| bin | MCP tool |';
const README_COUNTS = [/^(\w+) commands expose (\w+) MCP tools/m];
const SPEC_COUNTS = [/^(\w+) command-line tools/m, /\(the (\w+)\s+commands\)/];

const names = COMMANDS.map(command => command.name).sort();
const rows = COMMANDS.map(command => `${command.name} ${command.tool}`).sort();

describe('the command list is the same everywhere it is written', () => {
  it("package.json's bin has one entry per command, built from its own entry file, beside the server's", () => {
    const bin: Record<string, string> = JSON.parse(read('package.json')).bin;
    expect(Object.keys(bin).filter(name => name !== 'gmail-mcp').sort()).toEqual(names);
    for (const name of names) expect(bin[name], name).toBe(`./dist/cli/${name}.js`);
  });

  it('src/cli has one gmail-*.ts entry file per command, each running that command', () => {
    const entries = fs.readdirSync(cliDir).filter(file => /^gmail-.*\.ts$/.test(file) && !file.endsWith('.test.ts'));
    expect(entries.map(file => file.replace(/\.ts$/, '')).sort()).toEqual(names);
    for (const name of names) expect(fs.readFileSync(path.join(cliDir, `${name}.ts`), 'utf8'), name).toContain(`main('${name}', `);
  });

  it("the README's command table and the spec's bin table name each command with its MCP tool", () => {
    expect(tableRows(README, README_TABLE)).toEqual(rows);
    expect(tableRows(SPEC, SPEC_TABLE)).toEqual(rows);
  });

  it('the README and the spec count the commands as COMMANDS does', () => {
    expect(counts(README, README_COUNTS)).toEqual([COMMANDS.length, COMMANDS.length]);
    expect(counts(SPEC, SPEC_COUNTS)).toEqual([COMMANDS.length, COMMANDS.length]);
  });

  it('notices a table row or a count out of step', () => {
    const [first] = COMMANDS;
    const readmeRow = README.split('\n').find(line => line.startsWith(`| \`${first.name} `));
    expect(readmeRow).toBeDefined();
    expect(tableRows(README.replace(`${readmeRow}\n`, ''), README_TABLE)).not.toEqual(rows);
    expect(tableRows(SPEC.replace(`| \`${first.name}\` | \`${first.tool}\` |\n`, ''), SPEC_TABLE)).not.toEqual(rows);
    expect(tableRows(SPEC.replace(`\`${first.tool}\` |`, '`other_tool` |'), SPEC_TABLE)).not.toEqual(rows);
    expect(counts(README.replace(/^\w+ commands expose/m, 'Eight commands expose'), README_COUNTS)).not.toEqual([COMMANDS.length, COMMANDS.length]);
    expect(counts(SPEC.replace(/\(the \w+(\s+)commands\)/, '(the many$1commands)'), SPEC_COUNTS)).not.toEqual([COMMANDS.length, COMMANDS.length]);
  });
});
