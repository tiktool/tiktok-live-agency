import type { Metadata } from 'next';
import Link from 'next/link';
import { attempt, planLabel, tt } from '@/lib/tt';
import './globals.css';

export const metadata: Metadata = { title: 'Agency dashboard', description: 'TikTok LIVE agency dashboard built on tiktok-live-agency' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const account = await attempt(() => tt.getAccount());
  return (
    <html lang="en">
      <body>
        <header className="border-b border-[var(--line)]">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold">Agency dashboard</Link>
            <Link href="/live" className="muted hover:text-[var(--ink)]">Live now</Link>
            <Link href="/recruit" className="muted hover:text-[var(--ink)]">Find creators</Link>
            <span className="ml-auto rounded-full border border-[var(--line)] px-3 py-1 text-xs">
              {account.ok ? `${planLabel(account.data.tier)} plan` : 'Set TIKTOOLS_API_KEY'}
            </span>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
