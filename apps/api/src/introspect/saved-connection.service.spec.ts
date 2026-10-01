import { describe, expect, it } from 'vitest';
import { ENGINE_MANIFEST } from '../engines/engines.manifest';
import { mergeSecrets, publicView } from './saved-connection.service';

/** Phase 6c — the two rules that keep saved secrets where they were saved. */
const FIELDS = ENGINE_MANIFEST[0]!.capabilities.connectionFields;

const saved = {
  host: 'db.example.com',
  port: 5432,
  database: 'shop',
  user: 'reader',
  password: 's3cret',
  sslmode: 'require',
  ssh: 'ssh',
  ssh_host: 'bastion.example.com',
  ssh_port: 22,
  ssh_user: 'jump',
  ssh_auth: 'key',
  ssh_private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-body',
};

describe('mergeSecrets', () => {
  const edited = { ...saved, password: '', ssh_private_key: '', schemas: ['public'] };

  it('keeps a blank secret while the target is unchanged', () => {
    expect(mergeSecrets(FIELDS, saved, edited)).toMatchObject({
      password: 's3cret',
      ssh_private_key: saved.ssh_private_key,
      schemas: ['public'],
    });
  });

  it('lets a typed secret replace the saved one', () => {
    expect(mergeSecrets(FIELDS, saved, { ...edited, password: 'new' }).password).toBe('new');
  });

  it.each([
    ['host', { host: 'evil.example.com' }],
    ['user', { user: 'postgres' }],
    ['SSH host', { ssh_host: 'evil.example.com' }],
    ['SSH off', { ssh: 'none' }],
  ])('refuses to carry a saved secret to a changed %s', (_what, change) => {
    expect(() => mergeSecrets(FIELDS, saved, { ...edited, ...change })).toThrow(/enter it again/);
  });

  it('treats a missing input equal to its default as unchanged', () => {
    const { port: _port, ssh_port: _sshPort, ...withoutPorts } = edited;
    expect(mergeSecrets(FIELDS, saved, withoutPorts).password).toBe('s3cret');
  });
});

describe('publicView', () => {
  it('never returns a password or private key, and says which are set', () => {
    const view = publicView(FIELDS, { ...saved, sslkey: '-----BEGIN PRIVATE KEY-----' });
    const json = JSON.stringify(view);
    expect(json).not.toContain('s3cret');
    expect(json).not.toContain('key-body');
    expect(json).not.toContain('BEGIN PRIVATE KEY');
    expect([...view.secretsSet].sort()).toEqual(['password', 'ssh_private_key', 'sslkey']);
    expect(view.values).toMatchObject({ host: 'db.example.com', ssh_host: 'bastion.example.com' });
  });
});
