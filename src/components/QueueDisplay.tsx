'use client';

import { useEffect, useState } from 'react';
import { useQueueStore } from '@/store/useQueueStore';
import { DISPLAY_DURATION_STANDARD } from '@/lib/constants';

export const QueueDisplay = () => {
  const { queue, currentItem } = useQueueStore();
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!currentItem || !currentItem.expiresAt) return;
    
    const interval = setInterval(() => {
      setTimeLeft(Math.max(0, currentItem.expiresAt - Date.now()));
    }, 1000);
    
    return () => clearInterval(interval);
  }, [currentItem]);

  const formatTime = (ms: number) => {
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  const shortenAddress = (addr: string) => addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : '';

  const estimateWaitTime = (position: number) => {
    const currentRemaining = currentItem?.expiresAt ? timeLeft : 0;
    return currentRemaining + (position * DISPLAY_DURATION_STANDARD);
  };

  return (
    <div className="group relative">
      <div className="relative bg-gradient-to-br from-[#12121a] to-[#1a1a25] rounded-2xl border border-white/[0.06] overflow-hidden transition-all duration-300 hover:border-[#00f5ff]/20 hover:shadow-[0_0_40px_rgba(0,245,255,0.1)]">
        <div className="absolute inset-0 rounded-2xl p-[1px] bg-gradient-to-br from-[#00f5ff]/30 via-transparent to-[#bf00ff]/20 pointer-events-none" style={{ mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', maskComposite: 'exclude' }} />
        
        <div className="relative flex items-center justify-between px-5 py-4 border-b border-white/[0.06] bg-black/20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#39ff14]/20 to-[#00f5ff]/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-[#39ff14]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-white/90 tracking-wide uppercase" style={{ fontFamily: 'Orbitron, sans-serif' }}>Queue Status</h2>
          </div>
          
          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#39ff14]/10 border border-[#39ff14]/30 rounded-full">
            <div className="w-1.5 h-1.5 bg-[#39ff14] rounded-full animate-pulse" />
            <span className="text-[#39ff14] text-[10px] font-semibold tracking-wide" style={{ fontFamily: 'Orbitron, sans-serif' }}>
              {queue.length + (currentItem ? 1 : 0)} Active
            </span>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {currentItem ? (
            <div className={`relative p-4 rounded-xl border overflow-hidden ${
              currentItem.isPriority 
                ? 'bg-gradient-to-br from-[#bf00ff]/10 to-[#ff00aa]/5 border-[#bf00ff]/30' 
                : 'bg-gradient-to-br from-[#00f5ff]/10 to-[#39ff14]/5 border-[#00f5ff]/30'
            }`}>
              <div className={`absolute top-0 left-0 right-0 h-0.5 ${
                currentItem.isPriority 
                  ? 'bg-gradient-to-r from-[#bf00ff] to-[#ff00aa]' 
                  : 'bg-gradient-to-r from-[#00f5ff] to-[#39ff14]'
              }`} />
              
              <div className="flex items-center justify-between mb-3">
                <span className={`text-[10px] font-semibold tracking-wider uppercase ${
                  currentItem.isPriority ? 'text-[#ff00aa]' : 'text-[#00f5ff]'
                }`} style={{ fontFamily: 'Orbitron, sans-serif' }}>
                  {currentItem.isPriority ? '⚡ Priority' : '▶ Now Showing'}
                </span>
                <div 
                  className="text-xl font-bold tracking-wider"
                  style={{ fontFamily: 'Orbitron, sans-serif', color: currentItem.isPriority ? '#ff00aa' : '#00f5ff' }}
                >
                  {formatTime(timeLeft)}
                </div>
              </div>
              
              <p className="text-sm font-mono text-white/80">{shortenAddress(currentItem.tokenMint)}</p>
              <p className="text-xs font-mono text-[#606070] mt-1">by {shortenAddress(currentItem.walletAddress)}</p>
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-[#1a1a25] border border-white/[0.06] text-center">
              <p className="text-sm text-[#606070]">Showing default token</p>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[10px] text-[#606070] uppercase tracking-widest" style={{ fontFamily: 'Orbitron, sans-serif' }}>Up Next</h3>
              <span className="text-[10px] text-[#606070]">{queue.length} in queue</span>
            </div>
            
            {queue.length === 0 ? (
              <div className="py-6 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-lg bg-[#1a1a25] flex items-center justify-center">
                  <svg className="w-5 h-5 text-[#404050]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                </div>
                <p className="text-xs text-[#606070]">Queue is empty</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {queue.map((item, i) => (
                  <div 
                    key={item.id} 
                    className="flex items-center justify-between p-3 bg-[#1a1a25] hover:bg-[#22222f] border border-white/[0.04] rounded-xl transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-[#404050] w-6" style={{ fontFamily: 'Orbitron, sans-serif' }}>#{i + 1}</span>
                      <div>
                        <span className="text-sm font-mono text-white/80 block">{shortenAddress(item.tokenMint)}</span>
                        <span className="text-[10px] font-mono text-[#606070]">~{formatTime(estimateWaitTime(i))} wait</span>
                      </div>
                    </div>
                    {item.isPriority && <span className="text-[#bf00ff]">⚡</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 bg-black/30 border-t border-white/[0.06] flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-[#00f5ff] rounded-full" />
          <span className="text-[10px] text-[#606070]">Synced with Firestore</span>
        </div>
      </div>
    </div>
  );
};