import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strictInput, suggestReplacement, unknownArgumentsMessage } from './strict-input.js';
import { toolDefinitions } from './tools.js';

describe('suggestReplacement', () => {
  const accepted = ['messageId', 'attachmentId', 'maxResults', 'savePath'];

  it('matches the same name spelt with other case or separators', () => {
    expect(suggestReplacement('message_id', accepted)).toBe('messageId');
    expect(suggestReplacement('MAX-RESULTS', accepted)).toBe('maxResults');
  });

  it('matches the one accepted name that extends the given one at a word boundary', () => {
    expect(suggestReplacement('save', accepted)).toBe('savePath');
    expect(suggestReplacement('max', accepted)).toBe('maxResults');
  });

  it('matches a bare id to the one accepted name ending in Id, and only when there is one', () => {
    expect(suggestReplacement('id', ['threadId', 'format'])).toBe('threadId');
    expect(suggestReplacement('id', accepted)).toBeUndefined();
  });

  it('suggests nothing when no accepted name is evident', () => {
    expect(suggestReplacement('colour', accepted)).toBeUndefined();
    expect(suggestReplacement('mess', accepted)).toBeUndefined();
  });
});

describe('unknownArgumentsMessage', () => {
  it('names each unknown argument, the replacement where evident, and the accepted arguments', () => {
    expect(unknownArgumentsMessage(['message_id', 'colour'], ['messageId', 'format']))
      .toBe('Unknown arguments: message_id (use messageId instead), colour. Accepted arguments: messageId, format');
    expect(unknownArgumentsMessage(['x'], [])).toBe('Unknown argument: x. This tool takes no arguments');
  });
});

describe('strictInput', () => {
  it('refuses an unknown key with the message, and parses known keys as the shape does', () => {
    const schema = strictInput({ messageId: z.string(), format: z.string().default('full') });
    expect(schema.parse({ messageId: 'm1' })).toEqual({ messageId: 'm1', format: 'full' });
    const failed = schema.safeParse({ message_id: 'm1' });
    expect(failed.success).toBe(false);
    expect(failed.error?.issues.map(issue => issue.message)).toContain(
      'Unknown argument: message_id (use messageId instead). Accepted arguments: messageId, format',
    );
  });
});

// Every object a tool accepts, top level or nested (filter criteria, inline images), refuses
// keys it does not know.
function nonStrictObjects(schema: z.ZodTypeAny, path: string): string[] {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; type?: z.ZodTypeAny };
  switch (def.typeName) {
    case 'ZodObject': {
      const object = schema as z.ZodObject<z.ZodRawShape>;
      const here = object._def.unknownKeys === 'strict' ? [] : [path];
      return [...here, ...Object.entries(object.shape).flatMap(([key, value]) => nonStrictObjects(value as z.ZodTypeAny, `${path}.${key}`))];
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return nonStrictObjects(def.innerType!, path);
    case 'ZodEffects':
      return nonStrictObjects(def.schema!, path);
    case 'ZodArray':
      return nonStrictObjects(def.type!, `${path}[]`);
    default:
      return [];
  }
}

describe('tool input schemas', () => {
  it('are strict objects at every level, so no misnamed argument is dropped silently', () => {
    expect(toolDefinitions.flatMap(tool => nonStrictObjects(tool.schema, tool.name))).toEqual([]);
  });
});
