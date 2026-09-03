import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? process.env.CF_PAGES_URL ?? 'http://localhost:3000'),
  title: 'PriceDesk — Prisjakt 批量比价',
  description: '批量对比自有售价与 Prisjakt 市场最低、最高价格。',
  openGraph: {
    title: 'PriceDesk — Prisjakt 批量比价',
    description: '批量对比自有售价与 Prisjakt 市场最低、最高价格。',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: 'PriceDesk Prisjakt 批量比价' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PriceDesk — Prisjakt 批量比价',
    description: '批量对比自有售价与 Prisjakt 市场最低、最高价格。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
