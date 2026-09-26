import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { NoOrganizations, OrgList, homeDestination, listOrganizations } from '@/features/projects';

/**
 * `/` for a signed-in visitor: the organisation picker.
 *
 * Doc 01's tree puts a redirect at the root instead. A blanket redirect cannot live here:
 * the middleware already sends a visitor WITHOUT `sl_presence` to /login and one WITH it
 * away from /login, so a root page that redirected to /login would bounce forever. The
 * picker is the fixed point.
 *
 * One organisation redirects straight into it. A list of one is a click that carries no
 * information, and the overwhelming majority of accounts have exactly one.
 *
 * Server-rendered through `serverFetch`, which forwards the incoming cookie header — an
 * RSC fetch carries none of its own and would come back 401.
 */
export default async function HomePage() {
  const orgs = await listOrganizations();
  const destination = homeDestination(orgs);
  if (destination.kind === 'redirect') redirect(destination.href);

  return (
    <AppShell nav={[]}>
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold text-text">Your organisations</h1>
        <p className="mt-1 text-sm text-text-muted">
          Pick one to see the projects you can open inside it.
        </p>
        {destination.kind === 'empty' ? <NoOrganizations /> : <OrgList orgs={orgs} />}
      </div>
    </AppShell>
  );
}
