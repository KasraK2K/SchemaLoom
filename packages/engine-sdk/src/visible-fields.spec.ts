import { describe, expect, it } from 'vitest';
import { SSH_TUNNEL_FIELDS, visibleFields } from './capabilities.js';

const ids = (values: Record<string, unknown>) =>
  visibleFields(SSH_TUNNEL_FIELDS, values).map((f) => f.id);

describe('visibleFields (Phase 6 §10.1)', () => {
  it('hides the whole tunnel while it is off, defaults included', () => {
    expect(ids({})).toEqual(['ssh']);
    expect(ids({ ssh: 'none', ssh_auth: 'password' })).toEqual(['ssh']);
  });

  it('follows the login choice, reading an empty controller as its default', () => {
    expect(ids({ ssh: 'ssh' })).toContain('ssh_private_key');
    expect(ids({ ssh: 'ssh' })).not.toContain('ssh_password');
    expect(ids({ ssh: 'ssh', ssh_auth: 'password' })).toContain('ssh_password');
    expect(ids({ ssh: 'ssh', ssh_auth: 'password' })).not.toContain('ssh_passphrase');
  });

  it('hides a field whose controller is missing or cyclic instead of looping', () => {
    const fields = [
      { id: 'a', label: 'a', kind: 'text', required: false, showWhen: { field: 'b', in: ['x'] } },
      { id: 'b', label: 'b', kind: 'text', required: false, showWhen: { field: 'a', in: ['x'] } },
      { id: 'c', label: 'c', kind: 'text', required: false, showWhen: { field: 'z', in: ['x'] } },
    ] as const;
    expect(visibleFields(fields, { a: 'x', b: 'x' })).toEqual([]);
  });
});
