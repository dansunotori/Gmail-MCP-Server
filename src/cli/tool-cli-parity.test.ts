import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cliAction, toolAction } from '../error-text.js';
import { getToolByName } from '../tools.js';
import { COMMANDS } from './commands.js';
import { parseCliArgs, parseOptions } from './common.js';

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// The words of a help example as a shell would split them: quoted strings stay whole.
function shellWords(line: string): string[] {
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

// The flag or positional a schema field is exposed by, under the naming rules: the field in
// kebab case (--save-path for savePath or save_path), with -file for a value read from a file,
// singular for a list given one item per flag (--attachment), --no-<field> for a boolean that
// defaults to true, or a positional of the same name (<message_id> for messageId).
// Whether a name a spec maps a field to is one of the command's own flags or positionals.
const isInputOf = (target: string, command: (typeof COMMANDS)[number]) =>
  command.positionals.includes(target) || (target.startsWith('--') && target.slice(2) in command.flags);

function exposedBy(field: string, command: (typeof COMMANDS)[number]): string | undefined {
  const declared = command.fields?.[field];
  if (declared !== undefined) return isInputOf(declared, command) ? declared : undefined;
  const key = normalise(field);
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  const flag = Object.keys(command.flags).find(name => [key, `${key}file`, singular, `no${key}`].includes(normalise(name)));
  if (flag !== undefined) return `--${flag}`;
  return command.positionals.find(name => normalise(name) === key);
}

describe('each command exposes its MCP tool one to one', () => {
  for (const command of COMMANDS) {
    it(`${command.name} has a flag or positional for every input of ${command.tool}`, () => {
      const schema = getToolByName(command.tool)?.schema as z.ZodObject<z.ZodRawShape> | undefined;
      expect(schema, command.tool).toBeDefined();
      const missing = Object.keys(schema!.shape).filter(field => command.inputOnly?.[field] === undefined && exposedBy(field, command) === undefined);
      expect(missing, `${command.name} lacks an option for these ${command.tool} inputs`).toEqual([]);
    });

    it(`${command.name} maps and leaves out only fields its tool has, onto its own inputs, with a reason for each left out`, () => {
      const shape = (getToolByName(command.tool)?.schema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(command.inputOnly ?? {}).filter(field => !(field in shape))).toEqual([]);
      expect(Object.entries(command.inputOnly ?? {}).filter(([, reason]) => reason.trim() === '')).toEqual([]);
      expect(Object.keys(command.fields ?? {}).filter(field => !(field in shape))).toEqual([]);
      expect(Object.entries(command.fields ?? {}).filter(([, target]) => !isInputOf(target, command))).toEqual([]);
    });

    it(`${command.name} names the same action as ${command.tool} in its error line`, () => {
      expect(cliAction(command.name)).toBe(toolAction(command.tool));
    });

    it(`every example in ${command.name} --help parses with the command's own parser`, () => {
      const examples = command.help().split('\n').map(line => line.trim()).filter(line => line.startsWith(`${command.name} `));
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        const [name, ...argv] = shellWords(example);
        expect(name).toBe(command.name);
        expect(() => parseCliArgs(argv, parseOptions({ flags: command.flags } as never)), example).not.toThrow();
      }
    });
  }
});
