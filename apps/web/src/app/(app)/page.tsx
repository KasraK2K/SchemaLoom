import { AppShell } from '@/components/app-shell/app-shell';

/**
 * `/` for a signed-in visitor: the organisation picker.
 *
 * Doc 01's tree puts a redirect at the root instead. A redirect cannot live here: the
 * middleware already sends a visitor WITHOUT `sl_presence` to /login and one WITH it
 * away from /login, so a root page that redirected to /login would bounce between the
 * two forever. The picker is the fixed point, and it is where "last org" will be read
 * from once there is a session to read it out of.
 */
export default function HomePage() {
  return (
    <AppShell nav={[]}>
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-lg font-semibold text-text">Your organisations</h1>
        <p className="mt-1 text-sm text-text-muted">
          The organisation list is fetched server-side from the API once
          <code className="mx-1 font-mono text-xs">src/lib/server-api.ts</code>
          lands.
        </p>
      </div>
    </AppShell>
  );
}
