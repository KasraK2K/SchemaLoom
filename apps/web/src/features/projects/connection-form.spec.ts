import { describe, expect, it } from 'vitest';
import {
  connectionPayload,
  draftFromUrl,
  initialDraft,
  type ConnectionField,
} from './connection-form';

const FIELDS: ConnectionField[] = [
  { id: 'host', label: 'Host', kind: 'text', required: true },
  { id: 'port', label: 'Port', kind: 'number', required: true, default: 5432 },
  { id: 'database', label: 'Database', kind: 'text', required: true },
  { id: 'user', label: 'User', kind: 'text', required: true },
  { id: 'password', label: 'Password', kind: 'secret', required: false },
  {
    id: 'sslmode',
    label: 'SSL',
    kind: 'select',
    required: true,
    options: ['require', 'disable'],
    default: 'require',
  },
  { id: 'schemas', label: 'Schemas', kind: 'list', required: false },
];

describe('connection form', () => {
  it('fills the fields from a pasted URL, decoding the parts', () => {
    const draft = draftFromUrl(
      FIELDS,
      initialDraft(FIELDS),
      'postgres://read%40er:p%3Ass@db.example.com:6543/shop?sslmode=disable&ignored=1',
    );
    expect(draft).toMatchObject({
      host: 'db.example.com',
      port: '6543',
      database: 'shop',
      user: 'read@er',
      password: 'p:ss',
      sslmode: 'disable',
    });
    expect(draft).not.toHaveProperty('ignored');
  });

  it('keeps the default port when the URL has none, and rejects a non-URL', () => {
    expect(draftFromUrl(FIELDS, initialDraft(FIELDS), 'postgres://u@h/d')?.port).toBe('5432');
    expect(draftFromUrl(FIELDS, initialDraft(FIELDS), 'not a url')).toBeNull();
  });

  it('sends numbers as numbers, lists as arrays, and leaves empties to the server', () => {
    expect(
      connectionPayload(FIELDS, {
        ...initialDraft(FIELDS),
        host: ' h ',
        user: 'u',
        schemas: 'public, billing ,',
      }),
    ).toEqual({
      host: 'h',
      port: 5432,
      user: 'u',
      sslmode: 'require',
      schemas: ['public', 'billing'],
    });
  });

  it('does not trim a password', () => {
    expect(connectionPayload(FIELDS, { password: ' pw ' })).toEqual({ password: ' pw ' });
  });
});

describe('connection form visibility (Phase 6 §10.1)', () => {
  const fields: ConnectionField[] = [
    { id: 'host', label: 'Host', kind: 'text', required: true },
    {
      id: 'ssh',
      label: 'Through',
      kind: 'select',
      required: true,
      options: ['none', 'ssh'],
      default: 'none',
    },
    {
      id: 'ssh_private_key',
      label: 'Key',
      kind: 'file',
      required: true,
      showWhen: { field: 'ssh', in: ['ssh'] },
    },
  ];

  it('never sends a field the user can no longer see', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----';
    const draft = { host: 'h', ssh: 'none', ssh_private_key: key };
    expect(connectionPayload(fields, draft)).toEqual({ host: 'h', ssh: 'none' });
    expect(connectionPayload(fields, { ...draft, ssh: 'ssh' })).toMatchObject({
      ssh_private_key: key,
    });
  });
});
