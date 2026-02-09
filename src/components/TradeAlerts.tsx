'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueueStore } from '@/store/useQueueStore';
import { useTradeSubscription } from '@/hooks/useTradeSubscription';
import { TradeEvent } from '@/lib/helius';

export const TradeAlerts = () => {
  const { currentToken } = useQueueStore();
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [alertsSent, setAlertsSent] = useState(0);
  const prevTokenRef = useRef(currentToken);

  // Clear trades when token changes
  useEffect(() => {
    if (prevTokenRef.current !== currentToken) {
      setTrades([]);
      prevTokenRef.current = currentToken;
    }
  }, [currentToken]);

  const handleTrade = useCallback((trade: TradeEvent) => {
    setTrades((prev) => [trade, ...prev].slice(0, 50));
    setAlertsSent((prev) => prev + 1);
  }, []);

  const { isConnected, lastTrade } = useTradeSubscription({
    tokenMint: currentToken,
    onTrade: handleTrade,
  });

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  const shortenAddress = (addr: string) => addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : '';

  return (
    <div className="group relative">
      <div className="relative bg-gradient-to-br from-[#12121a] to-[#1a1a25] rounded-2xl border border-white/[0.06] overflow-hidden transition-all duration-300 hover:border-[#00f5ff]/20 hover:shadow-[0_0_40px_rgba(0,245,255,0.1)]">
        <div className="absolute inset-0 rounded-2xl p-[1px] bg-gradient-to-br from-[#00f5ff]/30 via-transparent to-[#bf00ff]/20 pointer-events-none" style={{ mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', maskComposite: 'exclude' }} />
        
        <div className="relative flex items-center justify-between px-5 py-4 border-b border-white/[0.06] bg-black/20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff6b00]/20 to-[#ffea00]/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-[#ff6b00]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-white/90 tracking-wide uppercase" style={{ fontFamily: 'Orbitron, sans-serif' }}>Live Trades</h2>
          </div>
          
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-[#606070]">{alertsSent} alerts</span>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
              isConnected 
                ? 'bg-[#39ff14]/10 border border-[#39ff14]/30' 
                : 'bg-[#ff3366]/10 border border-[#ff3366]/30'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-[#39ff14] animate-pulse' : 'bg-[#ff3366]'}`} />
              <span className={`text-[10px] font-semibold tracking-wide ${isConnected ? 'text-[#39ff14]' : 'text-[#ff3366]'}`} style={{ fontFamily: 'Orbitron, sans-serif' }}>
                {isConnected ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {lastTrade && (
            <div className={`relative p-4 rounded-xl border overflow-hidden ${
              lastTrade.type === 'BUY' 
                ? 'bg-gradient-to-br from-[#39ff14]/10 to-[#00ff88]/5 border-[#39ff14]/40' 
                : 'bg-gradient-to-br from-[#ff3366]/10 to-[#ff0050]/5 border-[#ff3366]/40'
            }`}>
              <div className={`absolute top-0 left-0 right-0 h-0.5 ${
                lastTrade.type === 'BUY' 
                  ? 'bg-gradient-to-r from-[#39ff14] to-[#00ff88]' 
                  : 'bg-gradient-to-r from-[#ff3366] to-[#ff0050]'
              }`} />
              
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold px-2 py-1 rounded bg-black/20">{lastTrade.type === 'BUY' ? 'BUY' : 'SELL'}</span>
                  <span className={`text-lg font-bold ${lastTrade.type === 'BUY' ? 'text-[#39ff14]' : 'text-[#ff3366]'}`} style={{ fontFamily: 'Orbitron, sans-serif' }}>
                    {lastTrade.type}
                  </span>
                </div>
                <span className="text-xl font-bold text-white font-mono">{lastTrade.priceInSol.toFixed(4)} SOL</span>
              </div>
              
              <p className="text-xs text-[#606070] font-mono">{shortenAddress(lastTrade.wallet)} | {formatTime(lastTrade.timestamp)}</p>
            </div>
          )}

          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {trades.length === 0 ? (
              <div className="py-8 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-lg bg-[#1a1a25] flex items-center justify-center">
                  <svg className="w-5 h-5 text-[#404050]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-xs text-[#606070]">Waiting for trades...</p>
              </div>
            ) : (
              trades.map((trade, i) => (
                <div 
                  key={`${trade.signature}-${i}`} 
                  className={`flex items-center justify-between p-2.5 rounded-lg transition-colors ${
                    trade.type === 'BUY' 
                      ? 'bg-[#39ff14]/5 hover:bg-[#39ff14]/10' 
                      : 'bg-[#ff3366]/5 hover:bg-[#ff3366]/10'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                      trade.type === 'BUY' 
                        ? 'bg-[#39ff14]/20 text-[#39ff14]' 
                        : 'bg-[#ff3366]/20 text-[#ff3366]'
                    }`} style={{ fontFamily: 'Orbitron, sans-serif' }}>
                      {trade.type}
                    </span>
                    <span className="text-xs text-[#606070] font-mono">{shortenAddress(trade.wallet)}</span>
                  </div>
                  <span className="text-sm text-white font-mono">{trade.priceInSol.toFixed(4)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="px-5 py-3 bg-black/30 border-t border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-[#ff6b00] rounded-full" />
            <span className="text-[10px] text-[#606070]">Device API</span>
          </div>
          <span className="text-[10px] text-[#606070]">Alerts -&gt; External Device</span>
        </div>
      </div>
    </div>
  );
};
