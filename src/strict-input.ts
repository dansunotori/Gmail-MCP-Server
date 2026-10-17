/**
 * Unknown-argument refusal. A plain zod object strips keys it does not know, so a misnamed
 * argument (`message_id` for `messageId`) would be dropped and the call would run without it.
 * Every tool input schema, and every object nested in one, is built with strictInput instead,
 * and refuses an unknown key with a message naming it, the input to use where one is evident,
 * and the accepted names. The server checks every call's arguments against the tool's schema
 * before its handler runs (createGmailServer in src/server.ts), and the CLIs' --input goes
 * through the same schemas, so it refuses an unknown field in the same words.
 */

import { z } from 'zod';

const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The accepted name an unknown name most likely meant, or undefined: an accepted name spelt the
 * same apart from case and separators (`message_id` is `messageId`), else the one accepted name
 * that extends it at a word boundary (`save` is `savePath`), else, for a bare `id`, the one
 * accepted name ending in `Id`.
 */
export function suggestReplacement(name: string, accepted: readonly string[]): string | undefined {
  const unique = (candidates: string[]): string | undefined => (candidates.length === 1 ? candidates[0] : undefined);
  const sameSpelling = unique(accepted.filter(a => normalise(a) === normalise(name)));
  if (sameSpelling !== undefined) return sameSpelling;
  const extending = unique(accepted.filter(a => a.length > name.length && a.startsWith(name) && /[A-Z_-]/.test(a[name.length])));
  if (extending !== undefined) return extending;
  if (normalise(name) === 'id') return unique(accepted.filter(a => /(?:Id|_id)$/.test(a)));
  return undefined;
}

/** An unknown name as a refusal names it: with the input to use instead, when there is one. */
function withReplacementHint(name: string, replacement: string | undefined): string {
  return replacement === undefined ? name : `${name} (use ${replacement} instead)`;
}

/** The refusal text for unknown arguments. */
export function unknownArgumentsMessage(unknown: readonly string[], accepted: readonly string[]): string {
  const named = unknown.map(name => withReplacementHint(name, suggestReplacement(name, accepted)));
  const head = `Unknown argument${unknown.length === 1 ? '' : 's'}: ${named.join(', ')}.`;
  return accepted.length === 0 ? `${head} This tool takes no arguments` : `${head} Accepted arguments: ${accepted.join(', ')}`;
}

/** An object of the given shape that refuses unknown keys with unknownArgumentsMessage. */
export function strictInput<S extends z.ZodRawShape>(shape: S) {
  const accepted = Object.keys(shape);
  return z.object(shape, {
    errorMap: (issue, context) => (issue.code === 'unrecognized_keys'
      ? { message: unknownArgumentsMessage(issue.keys, accepted) }
      : { message: context.defaultError }),
  }).strict();
}
