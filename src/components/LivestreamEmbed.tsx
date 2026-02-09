'use client';

import { useState } from 'react';
import { LIVESTREAM_URL } from '@/lib/constants';

export const LivestreamEmbed = () => {
  const [isLoaded, setIsLoaded] = useState(false);

  return (
    <div className="group relative h-full">
      {/* Card Container */}
      <div className="relative h-full bg-gradient-to-br from-[#12121a] to-[#1a1a25] rounded-2xl border border-white/[0.06] overflow-hidden transition-all duration-300 hover:border-[#00f5ff]/20 hover:shadow-[0_0_40px_rgba(0,245,255,0.1)] flex flex-col">
        {/* Gradient Border Effect */}
        <div className="absolute inset-0 rounded-2xl p-[1px] bg-gradient-to-br from-[#00f5ff]/30 via-transparent to-[#bf00ff]/20 pointer-events-none" style={{ mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', maskComposite: 'exclude' }} />

        {/* Header */}
        <div className="relative flex items-center justify-between px-5 py-4 border-b border-white/[0.06] bg-black/20 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#ff3366]/10 border border-[#ff3366]/30 rounded-full">
              <div className="w-2 h-2 bg-[#ff3366] rounded-full animate-pulse" />
              <span className="text-[#ff3366] text-[10px] font-semibold tracking-wider uppercase" style={{ fontFamily: 'Orbitron, sans-serif' }}>Live</span>
            </div>
            <h2 className="text-sm font-semibold text-white/80 tracking-wide uppercase" style={{ fontFamily: 'Orbitron, sans-serif' }}>Livestream</h2>
          </div>

          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#39ff14]" />
            <span className="text-[10px] text-[#606070] uppercase tracking-wide">HD</span>
          </div>
        </div>

        {/* Video Container - Takes remaining space */}
        <div className="relative flex-1 min-h-[400px] lg:min-h-[500px] bg-black">
          {/* Loading State */}
          {!isLoaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0a0a0f]">
              <div className="relative">
                <div className="w-12 h-12 border-2 border-[#00f5ff]/20 rounded-full" />
                <div className="absolute inset-0 w-12 h-12 border-2 border-transparent border-t-[#00f5ff] rounded-full animate-spin" />
              </div>
              <p className="mt-4 text-xs text-[#606070] uppercase tracking-widest" style={{ fontFamily: 'Orbitron, sans-serif' }}>Loading Stream...</p>
            </div>
          )}

          {/* Iframe */}
          <iframe
            src={LIVESTREAM_URL}
            className={`absolute inset-0 w-full h-full transition-opacity duration-500 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
            allowFullScreen
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            onLoad={() => setIsLoaded(true)}
          />

          {/* Corner Accents */}
          <div className="absolute top-3 left-3 w-8 h-8 border-l-2 border-t-2 border-[#00f5ff]/30 rounded-tl-lg pointer-events-none" />
          <div className="absolute top-3 right-3 w-8 h-8 border-r-2 border-t-2 border-[#00f5ff]/30 rounded-tr-lg pointer-events-none" />
          <div className="absolute bottom-3 left-3 w-8 h-8 border-l-2 border-b-2 border-[#bf00ff]/30 rounded-bl-lg pointer-events-none" />
          <div className="absolute bottom-3 right-3 w-8 h-8 border-r-2 border-b-2 border-[#bf00ff]/30 rounded-br-lg pointer-events-none" />
        </div>
      </div>
    </div>
  );
};
