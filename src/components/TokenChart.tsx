'use client';

import { useState, useEffect } from 'react';
import { useQueueStore } from '@/store/useQueueStore';

export const TokenChart = () => {
  const { currentToken, currentItem } = useQueueStore();
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
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const progress = currentItem && currentItem.expiresAt && currentItem.displayDuration
    ? ((currentItem.displayDuration - timeLeft) / currentItem.displayDuration) * 100 
    : 0;
    
  const chartUrl = `https://dexscreener.com/solana/${currentToken}?embed=1&theme=dark&info=0`;

  const isPriority = currentItem?.isPriority;

  return (
    <div className="group relative h-full">
      {/* Card Container */}
      <div className="relative h-full bg-gradient-to-br from-[#12121a] to-[#1a1a25] rounded-2xl border border-white/[0.06] overflow-hidden transition-all duration-300 hover:border-[#00f5ff]/20 hover:shadow-[0_0_40px_rgba(0,245,255,0.1)] flex flex-col">
        {/* Gradient Border Effect */}
        <div className="absolute inset-0 rounded-2xl p-[1px] bg-gradient-to-br from-[#00f5ff]/30 via-transparent to-[#bf00ff]/20 pointer-events-none" style={{ mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', maskComposite: 'exclude' }} />
        
        {/* Header */}
        <div className="relative flex items-center justify-between px-5 py-4 border-b border-white/[0.06] bg-black/20 flex-shrink-0">
          <div className="flex items-center gap-3">
            {currentItem ? (
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                isPriority 
                  ? 'bg-gradient-to-r from-[#bf00ff]/20 to-[#ff00aa]/20 border border-[#bf00ff]/40' 
                  : 'bg-[#00f5ff]/10 border border-[#00f5ff]/30'
              }`}>
                <span className="text-lg">{isPriority ? '⚡' : '🎯'}</span>
                <span className={`text-[10px] font-semibold tracking-wider uppercase ${isPriority ? 'text-[#ff00aa]' : 'text-[#00f5ff]'}`} style={{ fontFamily: 'Orbitron, sans-serif' }}>
                  {isPriority ? 'Priority' : 'Promoted'}
                </span>
              </div>
            ) : (
              <span className="text-sm text-[#606070] uppercase tracking-wide" style={{ fontFamily: 'Orbitron, sans-serif' }}>Default Token</span>
            )}
            
            <h2 className="text-sm font-semibold text-white/80 tracking-wide uppercase hidden sm:block" style={{ fontFamily: 'Orbitron, sans-serif' }}>Chart</h2>
          </div>

          {/* Timer */}
          {currentItem && (
            <div className="flex items-center gap-3">
              <div className="text-[10px] text-[#606070] uppercase tracking-wide hidden sm:block">Time Left</div>
              <div 
                className="text-2xl font-bold tracking-wider"
                style={{ 
                  fontFamily: 'Orbitron, sans-serif',
                  background: isPriority 
                    ? 'linear-gradient(135deg, #bf00ff, #ff00aa)' 
                    : 'linear-gradient(135deg, #00f5ff, #39ff14)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  textShadow: isPriority 
                    ? '0 0 30px rgba(191, 0, 255, 0.5)' 
                    : '0 0 30px rgba(0, 245, 255, 0.5)'
                }}
              >
                {formatTime(timeLeft)}
              </div>
            </div>
          )}
        </div>

        {/* Progress Bar */}
        {currentItem && (
          <div className="h-1 bg-[#0a0a0f] flex-shrink-0">
            <div 
              className={`h-full transition-all duration-300 relative ${
                isPriority 
                  ? 'bg-gradient-to-r from-[#bf00ff] to-[#ff00aa]' 
                  : 'bg-gradient-to-r from-[#00f5ff] to-[#39ff14]'
              }`}
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-[-2px] bottom-[-2px] w-4 bg-inherit blur-md" />
            </div>
          </div>
        )}

        {/* Chart iframe - Takes remaining space */}
        <div className="relative flex-1 min-h-[400px] lg:min-h-[500px] bg-black">
          <iframe
            key={currentToken}
            src={chartUrl}
            className="absolute inset-0 w-full h-full"
            title="Token Chart"
          />
          
          {/* Corner Accents */}
          <div className="absolute top-3 left-3 w-6 h-6 border-l-2 border-t-2 border-[#00f5ff]/20 rounded-tl pointer-events-none" />
          <div className="absolute top-3 right-3 w-6 h-6 border-r-2 border-t-2 border-[#00f5ff]/20 rounded-tr pointer-events-none" />
          <div className="absolute bottom-3 left-3 w-6 h-6 border-l-2 border-b-2 border-[#bf00ff]/20 rounded-bl pointer-events-none" />
          <div className="absolute bottom-3 right-3 w-6 h-6 border-r-2 border-b-2 border-[#bf00ff]/20 rounded-br pointer-events-none" />
        </div>

        {/* Token Address Footer */}
        <div className="px-5 py-3 border-t border-white/[0.06] bg-black/30 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#606070] uppercase tracking-wide">Token:</span>
            <code className="text-xs text-[#a0a0b0] font-mono">{currentToken.slice(0, 8)}...{currentToken.slice(-8)}</code>
          </div>
          <a 
            href={`https://dexscreener.com/solana/${currentToken}`} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-[10px] text-[#00f5ff] hover:text-[#39ff14] transition-colors uppercase tracking-wide"
            style={{ fontFamily: 'Orbitron, sans-serif' }}
          >
            Open Full →
          </a>
        </div>
      </div>
    </div>
  );
};
