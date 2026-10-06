import { describe, expect, it } from 'vitest';
import entra from './fixtures/entra.json';
import okta from './fixtures/okta.json';
import {
  groupPatch,
  groupResource,
  nameOf,
  parseFilter,
  parsePage,
  userPatch,
  userResource,
} from './scim.protocol';

/** Roadmap 14b §4 — filters and PATCH, against the request shapes Okta and Entra send. */

describe('parseFilter', () => {
  it('reads `attr eq "value"`, case-insensitively on the attribute', () => {
    expect(parseFilter('userName eq "ann@acme.test"', ['username'])).toEqual({
      attribute: 'username',
      value: 'ann@acme.test',
    });
    expect(parseFilter('externalId EQ "a\\"b"', ['externalid'])).toEqual({
      attribute: 'externalid',
      value: 'a"b',
    });
    expect(parseFilter(undefined, ['username'])).toBeNull();
  });

  it('refuses anything wider rather than listing everything', () => {
    for (const raw of [
      'userName sw "ann"',
      'userName eq "a" and active eq true',
      'title eq "x"',
      'userName eq ann',
    ])
      expect(() => parseFilter(raw, ['username'])).toThrow(/Supported filters/);
  });
});

describe('parsePage', () => {
  it('is 1-based and clamped', () => {
    expect(parsePage(undefined, undefined)).toEqual({ skip: 0, take: 100 });
    expect(parsePage('11', '10')).toEqual({ skip: 10, take: 10 });
    expect(parsePage('0', '5000')).toEqual({ skip: 0, take: 200 });
    expect(parsePage('x', '0')).toEqual({ skip: 0, take: 0 });
  });
});

describe('User PATCH', () => {
  it('Okta: deactivate and reactivate (no path, object value)', () => {
    expect(userPatch(okta.deactivateUser)).toEqual({ active: false });
    expect(userPatch(okta.reactivateUser)).toEqual({ active: true });
  });

  it('Okta: a name change', () => {
    const changes = userPatch(okta.updateUserName);
    expect(nameOf(changes)).toBe('Ann Lee');
  });

  it('Entra: "Replace" with a path and a string boolean', () => {
    expect(userPatch(entra.disableUser)).toEqual({ active: false });
  });

  it('Entra: several attributes at once; unknown ones (title) are ignored', () => {
    const changes = userPatch(entra.updateUserAttributes);
    expect(changes).toEqual({
      displayName: 'Ann Lee-Park',
      givenName: 'Ann',
      familyName: 'Lee-Park',
      externalId: 'a1b2c3d4-ENTRA',
    });
    expect(nameOf(changes)).toBe('Ann Lee-Park');
  });

  it('Entra: an email change through the filtered emails path', () => {
    expect(userPatch(entra.changeUserEmail)).toEqual({ email: 'ann.park@acme.test' });
  });

  it('refuses an unknown op and a malformed body', () => {
    expect(() => userPatch({ Operations: [{ op: 'move', path: 'active' }] })).toThrow(/op/);
    expect(() => userPatch({})).toThrow(/Operations/);
    expect(() =>
      userPatch({ Operations: [{ op: 'replace', path: 'active', value: 'yes' }] }),
    ).toThrow(/boolean/);
  });
});

describe('User resource (POST)', () => {
  it('Okta and Entra creates read the same way', () => {
    expect(userResource(okta.createUser)).toMatchObject({
      userName: 'ann.lee@acme.test',
      email: 'ann.lee@acme.test',
      externalId: '00u1abcdOKTA',
      active: true,
    });
    const fromEntra = userResource(entra.createUser);
    expect(fromEntra).toMatchObject({ userName: 'Ann.Lee@acme.test', active: true });
    expect(nameOf(fromEntra)).toBe('Ann Lee');
  });
});

describe('Group PATCH', () => {
  it('Okta: rename through a pathless replace', () => {
    expect(groupPatch(okta.renameGroup)).toEqual({ displayName: 'Data Team', add: [], remove: [] });
  });

  it('Okta: add members, then remove one by filter path', () => {
    expect(groupPatch(okta.addGroupMembers)).toEqual({ add: ['usr_ann', 'usr_bob'], remove: [] });
    expect(groupPatch(okta.removeGroupMember)).toEqual({ add: [], remove: ['usr_bob'] });
  });

  it('Entra: rename by path, add, and remove with a value list', () => {
    expect(groupPatch(entra.renameGroup)).toEqual({
      displayName: 'Data Team',
      add: [],
      remove: [],
    });
    expect(groupPatch(entra.addGroupMember)).toEqual({ add: ['usr_ann'], remove: [] });
    expect(groupPatch(entra.removeGroupMember)).toEqual({ add: [], remove: ['usr_bob'] });
  });

  it('replace members sets the list; remove members with no value empties it', () => {
    expect(
      groupPatch({
        Operations: [
          { op: 'add', path: 'members', value: [{ value: 'a' }] },
          { op: 'replace', path: 'members', value: [{ value: 'b' }] },
          { op: 'add', path: 'members', value: [{ value: 'c' }] },
        ],
      }),
    ).toEqual({ add: ['c'], remove: [], replace: ['b'] });
    expect(groupPatch({ Operations: [{ op: 'remove', path: 'members' }] })).toEqual({
      add: [],
      remove: [],
      replace: [],
    });
  });

  it('refuses a path it does not understand', () => {
    expect(() =>
      groupPatch({ Operations: [{ op: 'replace', path: 'owners', value: 'x' }] }),
    ).toThrow(/Unsupported path/);
  });

  it('a full resource replaces the member list', () => {
    expect(
      groupResource({ displayName: 'Ops', externalId: 'e1', members: [{ value: 'u1' }] }),
    ).toEqual({ displayName: 'Ops', externalId: 'e1', add: [], remove: [], replace: ['u1'] });
  });
});
