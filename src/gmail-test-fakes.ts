// Fakes the tests share for what the Gmail client hands back.

// A message's headers as Gmail lists them, from name: value pairs in the order given.
export const headerList = (fields: Record<string, string>) => Object.entries(fields).map(([name, value]) => ({ name, value }));

// A failed Gmail request as the client throws it: the HTTP status, and Gmail's error reason
// when one is given.
export function httpError(status: number, reason?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: reason ? { error: { errors: [{ reason }] } } : {} },
  });
}
