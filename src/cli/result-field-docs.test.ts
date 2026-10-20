import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { getToolByName } from '../tools.js';
import { COMMANDS } from './commands.js';

// An optional field a read result can carry is written by hand in four places: the command's
// --help, its MCP tool's description, the command's row of the README's command table and the
// command's section of the CLI spec. This test keeps the four in step with what each command
// emits.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const README = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const SPEC = fs.readFileSync(path.join(root, 'docs/gmail-cli-spec.md'), 'utf8');

const MESSAGE_FIELDS = ['htmlBody', 'htmlBodyError', 'plainBodyError', 'calendarMethod', 'calendarReply', 'calendarFailures'];

// The optional fields each command can emit, as its code writes them.
const EMITTED: Record<string, string[]> = {
  'gmail-get-message': MESSAGE_FIELDS,
  'gmail-get-thread': MESSAGE_FIELDS,
  'gmail-get-inbox-with-threads': MESSAGE_FIELDS,
  'gmail-download-email': MESSAGE_FIELDS,
  'gmail-batch-fetch-window': ['htmlBody', 'htmlBodyError', 'calendarMethod', 'calendarReply'],
};

// The README row of the command, the line of its command table that opens with the command.
const readmeRow = (readme: string, name: string) => readme.split('\n').find(line => line.startsWith(`| \`${name} `) || line.startsWith(`| \`${name}\``)) ?? '';

// The spec section of the command: from its "### name" heading to the next heading.
const specSection = (spec: string, name: string) => spec.split(/^(?=#{2,3} )/m).find(section => section.startsWith(`### ${name}\n`)) ?? '';

// Each place a field is missing from, as "command: field missing from place".
function missing(readme: string, spec: string): string[] {
  const gaps: string[] = [];
  for (const [name, fields] of Object.entries(EMITTED)) {
    const command = COMMANDS.find(candidate => candidate.name === name)!;
    const places: Record<string, string> = {
      '--help': command.help(),
      [`the ${command.tool} description`]: getToolByName(command.tool)?.description ?? '',
      'the README command table': readmeRow(readme, name),
      'the CLI spec section': specSection(spec, name),
    };
    for (const field of fields) {
      for (const [place, text] of Object.entries(places)) {
        if (!new RegExp(`\\b${field}\\b`).test(text)) gaps.push(`${name}: ${field} missing from ${place}`);
      }
    }
  }
  return gaps;
}

describe('the optional result fields are documented wherever each command is', () => {
  it('names every field a command emits in its help, its tool description, its README row and its spec section', () => {
    expect(missing(README, SPEC)).toEqual([]);
  });

  it('notices a field dropped from one place', () => {
    const row = readmeRow(README, 'gmail-get-thread');
    expect(row).not.toBe('');
    expect(missing(README.replace(row, row.replace(/htmlBody\b/g, 'html')), SPEC)).toContain('gmail-get-thread: htmlBody missing from the README command table');
    expect(specSection(SPEC, 'gmail-download-email')).not.toBe('');
  });
});
