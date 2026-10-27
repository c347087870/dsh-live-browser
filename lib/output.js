/**
 * Shared tool `output` declaration: permissive schema + pretty-printed JSON.
 *
 * Kept in its own module because both the tool registry and the tests import it
 * without pulling in the tool implementations.
 */
export function jsonOutput() {
  return {
    schema: {},
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}
