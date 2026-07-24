import type { Metadata, Viewport } from 'next';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import AccessibilityPanel from '@/components/AccessibilityPanel';
import {
  SITE_URL,
  SITE_NAME,
  SITE_DESCRIPTION,
  SITE_ORIGIN_WITH_BASE,
  resolveOgImage,
} from '@/utils/site';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

const defaultImage = resolveOgImage(null, null, null, SITE_NAME);

/**
 * Discord renders the coloured bar down the left edge of an embed from
 * `theme-color`. Without it the bar is grey and the embed reads as
 * generic-link rather than as ours.
 */
export const viewport: Viewport = {
  themeColor: '#0ea5e9',
};

export const metadata: Metadata = {
  // Required for og:image to resolve to an absolute URL. Every scraper rejects
  // a relative one, so omitting this silently disables image cards everywhere.
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  icons: {
    icon: `${BASE}/assets/pulsar.png`,
    shortcut: `${BASE}/assets/pulsar.png`,
    apple: `${BASE}/assets/pulsar.png`,
  },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_ORIGIN_WITH_BASE,
    locale: 'en_US',
    images: [defaultImage],
  },
  twitter: {
    // Also the signal Discord reads to choose a large image over a thumbnail.
    card: 'summary_large_image',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [defaultImage.url],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${mono.variable} font-sans bg-black text-white min-h-screen flex flex-col`}>
        <Header />
        <main className="flex-1 pt-14">
          {children}
        </main>
        <Footer />
        <AccessibilityPanel />
      </body>
    </html>
  );
}
