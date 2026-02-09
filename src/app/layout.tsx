import type { Metadata } from 'next';
import { WalletProvider } from '@/components/WalletProvider';
import { FirestoreInit } from '@/components/FirestoreInit';
import { WelcomeModal } from '@/components/WelcomeModal';
import { MobileBlocker } from '@/components/MobileBlocker';
import './globals.css';

export const metadata: Metadata = {
  title: 'SessionMint - Token Promotion Platform',
  description: 'Pay to promote your Solana token on the livestream. Real-time queue, live trade alerts, and priority takeover.',
  keywords: ['Solana', 'crypto', 'token promotion', 'livestream', 'DeFi'],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className="min-h-screen">
        <MobileBlocker />
        <WalletProvider>
          <FirestoreInit />
          <WelcomeModal />
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
