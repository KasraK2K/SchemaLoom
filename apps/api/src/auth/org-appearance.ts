import { readOrgSettings } from '@schemaloom/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * Docs/phase17/ORG-DEFAULT.md D2: a new account starts on its org's default look. Called once,
 * inside the `SignupPolicy.createUser` transaction that creates the account through an org
 * (invite sign-up, SSO JIT), so the row already holds the look before the first `/auth/me`.
 * An org with no default, or one that is gone, leaves the account on Studio Jade.
 */
export async function applyOrgAppearance(
  tx: Prisma.TransactionClient,
  userId: string,
  organizationId: string,
): Promise<void> {
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const look = readOrgSettings(org?.settings).defaultAppearance;
  if (look === null) return;
  await tx.user.update({
    where: { id: userId },
    data: { uiTheme: look.theme, uiVariant: look.variant, theme: look.mode },
  });
}
