import { ApiError } from '@/lib/api-client';

/** The org-admin API's refusals, in words a person can act on. */
export function orgAdminMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.code === 'last_owner') {
    return 'An organisation needs at least one owner. Make someone else an owner first.';
  }
  if (error.status === 403) {
    return 'You do not have permission to do that. Owners and admins manage members and groups; only owners change or appoint owners.';
  }
  if (error.code === 'group_name_taken') return 'Another group already has that name.';
  if (error.status === 404) return 'That member or group no longer exists. Reload the page.';
  return error.message;
}
