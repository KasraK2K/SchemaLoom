import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
// Blueprint's fonts. `@font-face` only: a browser downloads a face when text uses it, so
// these cost nothing until someone picks Blueprint.
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SchemaLoom', template: '%s · SchemaLoom' },
  description: 'A visual database design workspace.',
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the script below writes a class onto <html> before
    // React runs, so the server HTML and the hydrated DOM differ there by design.
    // The font classes define --font-geist-sans/-mono, which theme.css's --font-sans and
    // --font-mono read. Self-hosted: no request to a font CDN at build or run time.
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Blocking on purpose. Run after paint and a dark-theme user sees a white
            flash on every load; it is ~200 bytes and never touches the network. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
