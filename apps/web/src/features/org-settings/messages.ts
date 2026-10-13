import { ApiError } from '@/lib/api-client';

/** Roadmap 24: refusals from the AI integration routes. */
const AI_MESSAGES: Record<string, string | undefined> = {
  ai_private_base_url: 'That address points at a private network, which the server will not call.',
  ai_base_url_unreachable: 'The server could not reach that base URL. Check the address.',
  ai_base_url_not_allowed: 'That base URL is not allowed.',
  ai_model_not_allowed: 'That model is not allowed for this integration.',
  ai_integration_not_in_org: 'That integration does not belong to this organisation.',
  ai_grant_exists: 'That access is already granted.',
  ai_server_integration_readonly:
    'The server-provided integration is managed by the operator and cannot be changed here.',
};

/** The org-admin API's refusals, in words a person can act on. */
export function orgAdminMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  const ai = AI_MESSAGES[error.code];
  if (ai !== undefined) return ai;
  if (error.code === 'last_owner') {
    return 'An organisation needs at least one owner. Make someone else an owner first.';
  }
  if (error.code === 'already_member') return 'That person is already a member.';
  if (error.code === 'own_role') {
    return 'You cannot change your own role. Ask another owner to do it.';
  }
  if (error.status === 403) {
    return 'You do not have permission to do that. Owners and admins manage members and groups; only owners change or appoint owners.';
  }
  if (error.code === 'group_name_taken') return 'Another group already has that name.';
  if (error.code === 'group_managed') {
    return 'Your identity provider manages this group. Change it there.';
  }
  if (error.code === 'mapping_exists') return 'That claim value is already mapped.';
  if (error.status === 404) return 'That member or group no longer exists. Reload the page.';
  return error.message;
}
