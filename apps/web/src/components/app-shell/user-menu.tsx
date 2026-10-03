'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Settings,
} from '@schemaloom/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AppearanceDialog } from '@/components/appearance-dialog';
import { signOut } from '@/features/auth';

export function UserMenu() {
  const [appearance, setAppearance] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Account">
            <Settings className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/settings/security">Account</Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setAppearance(true);
            }}
          >
            Appearance…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              // Full navigation: middleware must see `sl_presence` gone.
              void signOut().finally(() => {
                window.location.assign('/login');
              });
            }}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AppearanceDialog open={appearance} onOpenChange={setAppearance} />
    </>
  );
}
