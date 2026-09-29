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
import { signOut } from '@/features/auth';

export function UserMenu() {
  return (
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
  );
}
