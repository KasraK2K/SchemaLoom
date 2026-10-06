import { SCHEMA } from './scim.protocol';

/** Roadmap 14b §1.2 — the static discovery documents (RFC 7643 §5–§7). */

export const SERVICE_PROVIDER_CONFIG = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: 'https://schemaloom.dev/docs/scim',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'Bearer token',
      description: 'The SCIM token from Settings → Single sign-on → Directory sync',
      primary: true,
    },
  ],
};

const RESOURCE_TYPE = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';

export const RESOURCE_TYPES = [
  { schemas: [RESOURCE_TYPE], id: 'User', name: 'User', endpoint: '/Users', schema: SCHEMA.user },
  {
    schemas: [RESOURCE_TYPE],
    id: 'Group',
    name: 'Group',
    endpoint: '/Groups',
    schema: SCHEMA.group,
  },
];

const attr = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'string',
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

export const SCHEMAS = [
  {
    id: SCHEMA.user,
    name: 'User',
    attributes: [
      attr('userName', { required: true, uniqueness: 'server', mutability: 'immutable' }),
      attr('displayName'),
      attr('name', {
        type: 'complex',
        subAttributes: [attr('formatted'), attr('givenName'), attr('familyName')],
      }),
      attr('emails', {
        type: 'complex',
        multiValued: true,
        mutability: 'immutable',
        subAttributes: [attr('value'), attr('type'), attr('primary', { type: 'boolean' })],
      }),
      attr('active', { type: 'boolean' }),
      attr('externalId', { caseExact: true }),
    ],
  },
  {
    id: SCHEMA.group,
    name: 'Group',
    attributes: [
      attr('displayName', { required: true, uniqueness: 'server' }),
      attr('externalId', { caseExact: true }),
      attr('members', {
        type: 'complex',
        multiValued: true,
        subAttributes: [
          attr('value', { mutability: 'immutable' }),
          attr('display', { mutability: 'readOnly' }),
        ],
      }),
    ],
  },
];
