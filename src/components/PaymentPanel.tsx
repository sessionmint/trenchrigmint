'use client';

import { useState, useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useQueueStore } from '@/store/useQueueStore';
import { TREASURY_WALLET, STANDARD_PRICE, PRIORITY_BASIC, SOLANA_CLUSTER, SOLANA_NETWORK_LABEL } from '@/lib/constants';

export const PaymentPanel = () => {
  const [tokenMint, setTokenMint] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { addToQueue, removeCurrentAndAddPriority } = useQueueStore();

  const validateMint = (address: string) => {
    try { new PublicKey(address); return true; } catch { return false; }
  };

  const handlePayment = async (isPriority: boolean) => {
    setError(''); setSuccess('');

    if (!publicKey) { setError('Connect your wallet first'); return; }
    if (!tokenMint.trim()) { setError('Enter a token mint address'); return; }
    if (!validateMint(tokenMint)) { setError('Invalid token address'); return; }
    if (!TREASURY_WALLET || TREASURY_WALLET.includes('YOUR_')) { setError('Treasury wallet not configured'); return; }

    setIsLoading(true);

    try {
      const amount = isPriority ? PRIORITY_BASIC : STANDARD_PRICE;
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(TREASURY_WALLET),
          lamports: Math.floor(amount * LAMPORTS_PER_SOL),
        })
      );

      const signature = await sendTransaction(transaction, connection);
      await connection.confirmTransaction(signature, 'confirmed');

      if (isPriority) {
        await removeCurrentAndAddPriority(tokenMint.trim(), publicKey.toString(), signature);
      } else {
        await addToQueue(tokenMint.trim(), publicKey.toString(), STANDARD_PRICE, signature);
      }

      setTokenMint('');
      setSuccess(isPriority ? 'Priority takeover activated.' : 'Added to queue.');
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: unknown) {
      console.error('Payment error:', err);
      const errorMessage = err instanceof Error ? err.message : '';
      setError(errorMessage.includes('User rejected') ? 'Transaction cancelled' : 'Transaction failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="group relative">
      {/* Card Container */}
      <div className="relative bg-gradient-to-br from-[#12121a] to-[#1a1a25] rounded-2xl border border-white/[0.06] overflow-hidden transition-all duration-300 hover:border-[#00f5ff]/20 hover:shadow-[0_0_40px_rgba(0,245,255,0.1)]">
        {/* Gradient Border Effect */}
        <div className="absolute inset-0 rounded-2xl p-[1px] bg-gradient-to-br from-[#00f5ff]/30 via-transparent to-[#bf00ff]/20 pointer-events-none" style={{ mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', maskComposite: 'exclude' }} />
        
        {/* Header */}
        <div className="relative flex items-center justify-between px-5 py-4 border-b border-white/[0.06] bg-black/20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f5ff]/20 to-[#39ff14]/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-[#00f5ff]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-white/90 tracking-wide uppercase" style={{ fontFamily: 'Orbitron, sans-serif' }}>Load Session State</h2>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {/* Wallet Button */}
          {mounted ? (
            <WalletMultiButton className="!w-full !justify-center !rounded-xl" />
          ) : (
            <div className="h-12 bg-[#1a1a25] rounded-xl animate-pulse" />
          )}

          {/* Token Input */}
          <div>
            <label className="block text-[10px] text-[#606070] uppercase tracking-widest mb-2" style={{ fontFamily: 'Orbitron, sans-serif' }}>
              Token Mint Address
            </label>
            <input
              type="text"
              value={tokenMint}
              onChange={(e) => { setTokenMint(e.target.value); setError(''); }}
              placeholder="Enter Solana token address..."
              className="w-full px-4 py-3.5 bg-[#0a0a0f] border border-white/[0.06] rounded-xl text-white placeholder-[#404050] focus:outline-none focus:border-[#00f5ff]/50 focus:shadow-[0_0_0_3px_rgba(0,245,255,0.1),inset_0_0_20px_rgba(0,245,255,0.03)] transition-all font-mono text-sm"
            />
          </div>

          {/* Error/Success Messages */}
          {error && (
            <div className="flex items-center gap-2 px-4 py-3 bg-[#ff3366]/10 border border-[#ff3366]/30 rounded-xl">
              <svg className="w-4 h-4 text-[#ff3366] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span className="text-[#ff3366] text-sm">{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 px-4 py-3 bg-[#39ff14]/10 border border-[#39ff14]/30 rounded-xl">
              <svg className="w-4 h-4 text-[#39ff14] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-[#39ff14] text-sm">{success}</span>
            </div>
          )}

          {/* Buttons */}
          <div className="space-y-3">
            {/* Standard Button */}
            <button
              onClick={() => handlePayment(false)}
              disabled={isLoading || !publicKey}
              className="relative w-full py-4 bg-gradient-to-r from-[#00f5ff] to-[#00b8c5] rounded-xl font-semibold text-black text-sm uppercase tracking-wider transition-all hover:shadow-[0_0_30px_rgba(0,245,255,0.4)] hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none overflow-hidden group/btn"
              style={{ fontFamily: 'Orbitron, sans-serif' }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 translate-x-[-200%] group-hover/btn:translate-x-[200%] transition-transform duration-700" />
              <span className="relative">
                {isLoading ? 'Processing...' : `Queue Up - ${STANDARD_PRICE} SOL`}
              </span>
            </button>

            {/* Priority Button */}
            <button
              onClick={() => handlePayment(true)}
              disabled={isLoading || !publicKey}
              className="relative w-full py-4 bg-gradient-to-r from-[#bf00ff] to-[#ff00aa] rounded-xl font-semibold text-white text-sm uppercase tracking-wider transition-all hover:shadow-[0_0_30px_rgba(191,0,255,0.4)] hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 disabled:hover:shadow-none overflow-hidden group/btn"
              style={{ fontFamily: 'Orbitron, sans-serif' }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 translate-x-[-200%] group-hover/btn:translate-x-[200%] transition-transform duration-700" />
              <span className="relative flex items-center justify-center gap-2">
                <span>!</span>
                {isLoading ? 'Processing...' : `Priority - ${PRIORITY_BASIC} SOL`}
              </span>
            </button>
          </div>

          {/* Info */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 text-xs text-[#606070]">
              <div className="w-1 h-1 rounded-full bg-[#00f5ff]" />
              <span>Standard: Join queue, 10 min display</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-[#606070]">
              <div className="w-1 h-1 rounded-full bg-[#bf00ff]" />
              <span>Priority: Skip queue, take over now</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-[#ffea00]/5 border-t border-[#ffea00]/20 flex items-center gap-2">
          <svg className="w-4 h-4 text-[#ffea00]" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <span className="text-[#ffea00] text-xs">
            {SOLANA_CLUSTER === 'devnet'
              ? 'DEVNET - Get test SOL from faucet.solana.com'
              : `${SOLANA_NETWORK_LABEL.toUpperCase()} - Real SOL payments`}
          </span>
        </div>
      </div>
    </div>
  );
};

