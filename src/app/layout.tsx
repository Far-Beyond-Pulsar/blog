import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import AccessibilityPanel from '@/components/AccessibilityPanel';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: {
    default: 'Pulsar Blog',
    template: '%s | Pulsar Blog',
  },
  description: 'Engineering updates, deep dives, and release notes from the Pulsar game engine team.',
  icons: {
    icon: '/assets/pulsar.png',
    shortcut: '/assets/pulsar.png',
    apple: '/assets/pulsar.png',
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
