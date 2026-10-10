/** An error from the server, worded as it said, for a form or a row. */
export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
