import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? process.env.CF_PAGES_URL ?? 'http://localhost:3000'),
  title: 'PriceDesk — Nordic Price Comparison',
  description: 'Compare current MiStore and Prisjakt prices across four Nordic markets.',
  openGraph: {
    title: 'PriceDesk — Nordic Price Comparison',
    description: 'Compare current MiStore and Prisjakt prices across four Nordic markets.',
    images: [{ url: '/og.png', width: 1731, height: 909, alt: 'PriceDesk Nordic Price Comparison' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PriceDesk — Nordic Price Comparison',
    description: 'Compare current MiStore and Prisjakt prices across four Nordic markets.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
