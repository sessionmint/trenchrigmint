'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueueStore, type QueueItem } from '@/store/useQueueStore';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  LIVESTREAM_URL,
  TREASURY_WALLET,
  STANDARD_PRICE,
  PRIORITY_BASIC,
  PRIORITY_DUPLICATE,
  PRIORITY_PREMIUM,
  DISPLAY_DURATION_STANDARD,
  DEFAULT_TOKEN_MINT
} from '@/lib/constants';
import { withAppBasePath } from '@/lib/app-url';
import { LoadingSessionOverlay } from '@/components/LoadingSessionOverlay';
import type { PublicDeviceStatus } from '@/lib/device/types';

const ASPECT_RATIO = 16 / 9;
const SESSION_TRANSITION_DURATION = 10000; // 10 seconds

export default function Dashboard() {
  const [mounted, setMounted] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [streamWidth, setStreamWidth] = useState(0);
  const [streamHeight, setStreamHeight] = useState(0);
  const [dragging, setDragging] = useState<'stream' | null>(null);
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [sessionTokenMint, setSessionTokenMint] = useState<string | null>(null);

  const dragStart = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Listen for stream enabled event from WelcomeModal
  useEffect(() => {
    const handleStreamEnabled = () => {
      setStreamEnabled(true);
    };

    window.addEventListener('streamEnabled', handleStreamEnabled);
    return () => window.removeEventListener('streamEnabled', handleStreamEnabled);
  }, []);

  // Listen for new pump session event (when new token becomes active from queue)
  useEffect(() => {
    const handleNewPumpSession = async (event: CustomEvent<{ tokenMint: string }>) => {
      const { tokenMint } = event.detail;
      console.log('[Dashboard] New pump session started for:', tokenMint);

      // Set loading state
      setIsLoadingSession(true);
      setSessionTokenMint(tokenMint);

      // Stop the device
      try {
        await fetch(withAppBasePath('/api/device/autoblow/session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', tokenMint })
        });
        console.log('[Dashboard] Device stopped for session transition');
      } catch (error) {
        console.error('[Dashboard] Failed to stop device:', error);
      }
    };

    window.addEventListener('newPumpSession', handleNewPumpSession as unknown as EventListener);
    return () => window.removeEventListener('newPumpSession', handleNewPumpSession as unknown as EventListener);
  }, []);

  // Handle session loading complete (after 10 seconds)
  const handleSessionLoadComplete = useCallback(async () => {
    console.log('[Dashboard] Session load complete, starting device');

    // Start the device with default parameters
    try {
      await fetch(withAppBasePath('/api/device/autoblow/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', tokenMint: sessionTokenMint })
      });
      console.log('[Dashboard] Device started after session transition');
    } catch (error) {
      console.error('[Dashboard] Failed to start device:', error);
    }

    setIsLoadingSession(false);
    setSessionTokenMint(null);
  }, [sessionTokenMint]);

  // Fixed chart size
  const CHART_WIDTH = 380;
  const CHART_HEIGHT = 240;
  
  // Get queue store state (initialization handled by FirestoreInit in layout.tsx)
  const { currentToken } = useQueueStore();

  // Note: Queue expiry is handled by useQueueStore (timeout + 10s backup interval)
  // No need for additional polling here - reduces redundant API calls

  // Log token changes for debugging
  useEffect(() => {
    console.log('[Page] Current token changed:', currentToken);
  }, [currentToken]);

  const getMaxStreamWidth = useCallback((collapsed: boolean) => {
    const sidebarW = collapsed ? 0 : 300;
    const availableW = window.innerWidth - sidebarW;
    return Math.floor(availableW);
  }, []);

  useEffect(() => {
    const availableH = window.innerHeight;
    const maxW = getMaxStreamWidth(false);
    const initialW = Math.min(maxW, availableH * ASPECT_RATIO);
    const initialH = initialW / ASPECT_RATIO;
    setStreamWidth(initialW);
    setStreamHeight(initialH);
    setMounted(true);
  }, [getMaxStreamWidth]);

  const toggleSidebar = useCallback(() => {
    const newCollapsed = !sidebarCollapsed;
    setSidebarCollapsed(newCollapsed);
    
    if (newCollapsed) {
      setStreamWidth(streamWidth + 300);
    } else {
      setStreamWidth(Math.max(400, streamWidth - 300));
    }
  }, [sidebarCollapsed, streamWidth]);

  useEffect(() => {
    if (dragging !== 'stream') return;

    const onMove = (e: MouseEvent) => {
      const dy = e.clientY - dragStart.current.y;
      const currentRatio = dragStart.current.w / dragStart.current.h;
      
      const maxH = window.innerHeight;
      const newH = Math.max(225, Math.min(maxH, dragStart.current.h + dy));
      const newW = newH * currentRatio;
      
      const maxW = getMaxStreamWidth(sidebarCollapsed);
      setStreamWidth(Math.min(maxW, newW));
      setStreamHeight(newH);
    };

    const onUp = () => setDragging(null);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, sidebarCollapsed, getMaxStreamWidth]);

  const startStreamDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, y: e.clientY, w: streamWidth, h: streamHeight };
    setDragging('stream');
  };

  const getStreamUrl = useCallback(() => {
    const url = LIVESTREAM_URL;

    // Handle Kick player
    if (url.includes('player.kick.com') || url.includes('kick.com')) {
      const separator = url.includes('?') ? '&' : '?';
      // When enabled: autoplay with audio. When disabled: autoplay muted
      const muted = streamEnabled ? 'false' : 'true';
      return `${url}${separator}autoplay=true&muted=${muted}`;
    }

    // Handle YouTube
    let videoId = '';
    if (url.includes('youtube.com/watch')) {
      videoId = new URL(url).searchParams.get('v') || '';
    } else if (url.includes('youtube.com/embed/')) {
      videoId = url.split('/embed/')[1]?.split('?')[0] || '';
    } else if (url.includes('youtu.be/')) {
      videoId = url.split('youtu.be/')[1]?.split('?')[0] || '';
    }

    if (videoId) {
      // When enabled: autoplay with audio. When disabled: autoplay muted
      const mute = streamEnabled ? '0' : '1';
      return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=${mute}&controls=1&modestbranding=1&rel=0&showinfo=0&iv_load_policy=3&playsinline=1`;
    }

    // Default fallback
    return url.includes('?') ? `${url}&autoplay=1` : `${url}?autoplay=1`;
  }, [streamEnabled]);

  return (
    <div className={`dashboard ${dragging ? 'dragging' : ''}`}>
      <div className="bg-pattern" />

      {/* Loading Session Overlay - shown when new token becomes active */}
      <LoadingSessionOverlay
        isVisible={isLoadingSession}
        onComplete={handleSessionLoadComplete}
        duration={SESSION_TRANSITION_DURATION}
      />

      <div 
        className="stream-layer"
        style={{ width: streamWidth, height: streamHeight }}
      >
        <div className="layer-badge">
          <span className="dot" style={{ background: '#ef4444' }} />
          LIVE
        </div>
        <StreamEmbed key={streamEnabled ? 'enabled' : 'disabled'} url={getStreamUrl()} width={streamWidth} height={streamHeight} enabled={streamEnabled} />
        <div className="resize-handle stream" onMouseDown={startStreamDrag} />
      </div>

      <div
        className="chart-layer"
        style={{
          width: CHART_WIDTH,
          height: CHART_HEIGHT,
          top: 12,
          left: streamWidth - CHART_WIDTH - 12,
        }}
      >
        <div className="layer-badge">CHART</div>
        <ChartEmbed />
      </div>

      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <button 
          className="collapse-btn"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
        
        <div className="sidebar-header">
          <div className="brand-logo">
            <svg fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div className="brand-text">
            <h1>SessionMint</h1>
            <span>
              <span className="dot" style={{ background: '#eab308' }} />
              Devnet
            </span>
          </div>
        </div>
        
        <div className="sidebar-content">
          <div className="sidebar-scroll">
            <ActiveToken />
            <DeviceStatus />
            <PromoteForm mounted={mounted} />
            <QueueList />
          </div>
        </div>
      </aside>
    </div>
  );
}

function StreamEmbed({ url, width, height, enabled }: { url: string; width: number; height: number; enabled: boolean }) {
  const [loaded, setLoaded] = useState(false);

  const containerRatio = width / height;
  const videoRatio = 16 / 9;

  let iframeW, iframeH;
  if (containerRatio > videoRatio) {
    iframeW = width;
    iframeH = width / videoRatio;
  } else {
    iframeH = height;
    iframeW = height * videoRatio;
  }

  return (
    <>
      {!loaded && (
        <div className="loading">
          <div className="spinner" />
        </div>
      )}
      <iframe
        src={url}
        style={{
          opacity: loaded ? 1 : 0,
          transition: 'opacity 0.3s',
          width: iframeW,
          height: iframeH,
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: enabled ? 'auto' : 'none'
        }}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        onLoad={() => setLoaded(true)}
      />
      {!enabled && (
        <div className="stream-disabled-overlay">
          <div className="stream-disabled-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <p>Click &quot;I&apos;m ready to stroke&quot; to enable stream</p>
          </div>
        </div>
      )}
    </>
  );
}

function ChartEmbed() {
  const { currentToken } = useQueueStore();
  const url = `https://dexscreener.com/solana/${currentToken}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTimeframesToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=marketCap&interval=5`;
  return <iframe key={currentToken} src={url} title="Chart" />;
}

// Device polling intervals (conservative to avoid rate limits)
const DEVICE_POLL_ACTIVE = 3000;  // 3s when active (was 2s)
const DEVICE_POLL_IDLE = 8000;    // 8s when idle (was 5s)

function DeviceStatus() {
  const { currentToken, currentItem, refreshState, processQueue } = useQueueStore();
  const [status, setStatus] = useState<PublicDeviceStatus>({ connected: false, state: 'loading' });
  const [cooldownDisplay, setCooldownDisplay] = useState<number | null>(null);

  // Track if we've tried to start a session for current token
  const sessionStartAttempted = useRef(false);
  const lastTokenRef = useRef(currentToken);

  // Reset session attempt when token changes
  useEffect(() => {
    if (currentToken !== lastTokenRef.current) {
      sessionStartAttempted.current = false;
      lastTokenRef.current = currentToken;
    }
  }, [currentToken]);

  // Track cooldown start time for smooth client-side countdown
  const cooldownStartRef = useRef<{ startTime: number; duration: number } | null>(null);

  // Update cooldown display countdown - use client-side timing for smooth countdown
  useEffect(() => {
    if (status.cooldown?.active && status.cooldown.remainingMs > 0) {
      // Only set initial values if this is a new cooldown (not a poll update)
      if (!cooldownStartRef.current) {
        const now = Date.now();
        cooldownStartRef.current = {
          startTime: now - (status.cooldown.totalMs - status.cooldown.remainingMs),
          duration: status.cooldown.totalMs
        };
      }

      const updateDisplay = () => {
        if (!cooldownStartRef.current) return;

        const elapsed = Date.now() - cooldownStartRef.current.startTime;
        const remaining = Math.max(0, cooldownStartRef.current.duration - elapsed);
        const seconds = Math.ceil(remaining / 1000);

        if (seconds <= 0) {
          setCooldownDisplay(null);
          cooldownStartRef.current = null;
        } else {
          setCooldownDisplay(seconds);
        }
      };

      updateDisplay();
      const interval = setInterval(updateDisplay, 100); // Update frequently for smooth display

      return () => clearInterval(interval);
    } else {
      setCooldownDisplay(null);
      cooldownStartRef.current = null;
    }
  }, [status.cooldown?.active, status.cooldown?.remainingMs, status.cooldown?.totalMs]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let isMounted = true;

    const fetchStatus = async () => {
      if (!isMounted) return;

      try {
        // Fetch device status (now includes session from Firestore)
        const res = await fetch(withAppBasePath('/api/device/status'));
        if (!isMounted) return;

        const data = await res.json();

        // If device is active but no session exists, start one
        const isDevicePlaying = data.state === 'stroking' || data.state === 'active' ||
          data.deviceState?.operationalMode === 'OSCILLATOR_PLAYING';

        if (isDevicePlaying && !data.session && currentToken && !sessionStartAttempted.current) {
          sessionStartAttempted.current = true;
          console.log('[DeviceStatus] Device playing but no session, starting one for:', currentToken);
          // Start a session to get mode tracking
          try {
            const sessionRes = await fetch(withAppBasePath('/api/device/autoblow/session'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'start',
                tokenMint: currentToken,
                durationMs: currentItem?.displayDuration
              })
            });
            const sessionData = await sessionRes.json();
            console.log('[DeviceStatus] Session start response:', sessionData);

            // Re-fetch status to get the new session data
            const refreshRes = await fetch(withAppBasePath('/api/device/status'));
            const refreshData = await refreshRes.json();
            console.log('[DeviceStatus] Refreshed status:', refreshData.session ? `mode=${refreshData.session.mode}` : 'no session');
            setStatus(refreshData);
          } catch (e) {
            console.error('[DeviceStatus] Failed to start session:', e);
            setStatus(data);
          }
        } else {
          setStatus(data);
        }

        // Check for stale state: if server shows no cooldown, no session, and client has expired currentItem
        // This helps sync state when Firestore listeners aren't working
        if (currentItem && currentItem.expiresAt > 0) {
          const isExpired = currentItem.expiresAt <= Date.now();
          const serverHasNoActiveSession = !data.cooldown?.active && !data.session;

          if (isExpired && serverHasNoActiveSession) {
            console.log('[DeviceStatus] Detected stale state, triggering refresh and process...');
            // Refresh state from Firestore and process queue
            refreshState().then(() => {
              processQueue();
            });
          }
        }

        // Schedule next poll based on state (don't create overlapping intervals)
        const isActiveState = data.state === 'stroking' || data.state === 'active' || data.session;
        const inCooldown = data.cooldown?.active;
        // Poll faster during cooldown for accurate countdown
        const nextPoll = inCooldown ? 1000 : (isActiveState ? DEVICE_POLL_ACTIVE : DEVICE_POLL_IDLE);

        if (intervalId) clearTimeout(intervalId);
        intervalId = setTimeout(fetchStatus, nextPoll);
      } catch {
        if (!isMounted) return;
        setStatus({ connected: false, state: 'error' });
        // On error, wait longer before retry
        if (intervalId) clearTimeout(intervalId);
        intervalId = setTimeout(fetchStatus, DEVICE_POLL_IDLE * 2);
      }
    };

    // Initial fetch after small delay
    intervalId = setTimeout(fetchStatus, 500);

    return () => {
      isMounted = false;
      if (intervalId) clearTimeout(intervalId);
    };
  }, [currentToken, currentItem, refreshState, processQueue]);

  // Check if device is actively running based on multiple indicators
  const checkIsActive = () => {
    // Cooldown and waiting states are not "active"
    if (status.state === 'cooldown' || status.state === 'waiting') return false;
    // Check session with actual movement (speed > 15)
    if (status.session && status.session.speed > 15) return true;
    // Check state
    if (status.state === 'stroking' || status.state === 'active') return true;
    // Check raw deviceState for any indication of movement
    const ds = status.deviceState;
    if (ds) {
      // Check operationalMode (main indicator from Autoblow API)
      const opMode = ds.operationalMode || '';
      if (opMode === 'OSCILLATOR_PLAYING' || opMode === 'SYNC_SCRIPT_PLAYING' || opMode.includes('PLAYING')) {
        return true;
      }

      // Check oscillator speed
      if (ds.oscillatorTargetSpeed && ds.oscillatorTargetSpeed > 0) return true;
    }
    return false;
  };

  const isActive = checkIsActive();
  const isCooldown = status.state === 'cooldown' || status.cooldown?.active;
  const isWaiting = status.state === 'waiting';

  const getIndicatorColor = () => {
    if (isCooldown) return '#3b82f6'; // Blue for cooldown
    if (isWaiting) return '#f59e0b'; // Orange for waiting
    if (isActive) {
      // Color based on current mode
      const mode = status.session?.mode?.toLowerCase() || '';
      if (mode.includes('chop')) return '#14f0d5'; // Cyan for Chop Monster
      if (mode.includes('momentum')) return '#ff14a0'; // Magenta for Momentum Bursts
      if (mode.includes('mean')) return '#a855f7'; // Purple for Mean Reverter
      if (mode.includes('liquidity') || mode.includes('panic')) return '#ff3333'; // Red for Liquidity Panic
      return '#39ff14'; // Green for Trend Rider (default)
    }
    if (status.connected) return '#eab308'; // Yellow for idle
    return '#ef4444'; // Red for disconnected
  };

  const getStatusText = () => {
    // Priority 1: Cooldown state with countdown
    if (isCooldown && cooldownDisplay !== null) {
      return `Starting in ${cooldownDisplay}s`;
    }

    // Priority 2: Waiting for activity
    if (isWaiting) {
      return 'Waiting for activity';
    }

    // Priority 3: Session mode from Firestore
    if (status.session?.mode) return status.session.mode;

    // Priority 4: Device operational state
    const ds = status.deviceState;
    const opMode = ds?.operationalMode || '';

    if (opMode === 'OSCILLATOR_PLAYING' || status.state === 'stroking') return 'Active';
    if (opMode === 'SYNC_SCRIPT_PLAYING') return 'Synced';
    if (status.state === 'active') return 'Active';
    if (status.state === 'idle' || opMode === 'ONLINE_CONNECTED') return 'Idle';
    if (status.state === 'disconnected') return 'Offline';
    if (status.state === 'not_configured') return 'Not Setup';
    if (status.state === 'loading') return 'Connecting...';
    return status.state;
  };

  const getIndicatorClass = () => {
    if (isActive) return 'device-indicator blinking';
    if (isCooldown) return 'device-indicator pulsing';
    if (isWaiting) return 'device-indicator pulsing-slow';
    return 'device-indicator';
  };

  return (
    <div className="section device-section">
      <div className="section-title">Device</div>
      <div className="device-status">
        <span className={getIndicatorClass()} style={{ backgroundColor: getIndicatorColor() }} />
        <span className="device-text">{getStatusText()}</span>
      </div>
    </div>
  );
}

function ActiveToken() {
  const { currentItem, currentToken, processQueue } = useQueueStore();
  const [timeLeft, setTimeLeft] = useState(0);
  const lastProcessTime = useRef(0);
  const currentItemId = useRef<string | null>(null);

  const isDefault = currentToken === DEFAULT_TOKEN_MINT;

  useEffect(() => {
    if (!currentItem?.expiresAt) {
      setTimeLeft(0);
      lastProcessTime.current = 0;
      currentItemId.current = null;
      return;
    }

    // Reset process time when currentItem ID changes
    if (currentItemId.current !== currentItem.id) {
      currentItemId.current = currentItem.id;
      lastProcessTime.current = 0;
    }

    const update = () => {
      const remaining = Math.max(0, currentItem.expiresAt - Date.now());
      setTimeLeft(remaining);

      // When timer hits 0, trigger queue processing
      // Allow retries every 3 seconds if still expired
      const now = Date.now();
      const timeSinceLastProcess = now - lastProcessTime.current;

      if (remaining <= 0 && timeSinceLastProcess >= 3000) {
        lastProcessTime.current = now;
        console.log('[ActiveToken] Timer expired, processing queue...');
        processQueue();
      }
    };

    update();
    const i = setInterval(update, 1000);
    return () => clearInterval(i);
  }, [currentItem, processQueue]);

  const fmt = (ms: number) => {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const progress = currentItem?.expiresAt && currentItem?.displayDuration
    ? ((currentItem.displayDuration - timeLeft) / currentItem.displayDuration) * 100
    : 0;

  return (
    <div className="section">
      <div className="section-title-row" style={{ marginBottom: 8 }}>
        <span className="section-title">Now Showing</span>
        {!isDefault && currentItem && (
          <span className={`mini-timer ${currentItem.isPriority ? 'priority' : ''}`}>
            {fmt(timeLeft)}
          </span>
        )}
      </div>

      {/* Progress bar */}
      {!isDefault && currentItem && (
        <div className="progress-bg mini">
          <div
            className={`progress-bar ${currentItem.isPriority ? 'priority' : ''}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Token details - always visible */}
      <div className="token-details">
        <div className="detail-row">
          <span className="detail-label">Address</span>
          <span className="detail-value mono">{currentToken}</span>
        </div>
        {!isDefault && currentItem && (
          <>
            <div className="detail-row">
              <span className="detail-label">Type</span>
              <span className={`detail-value ${currentItem.isPriority ? 'text-purple' : 'text-green'}`}>
                {currentItem.isPriority ? 'Priority' : 'Promoted'}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Time Left</span>
              <span className={`detail-value ${currentItem.isPriority ? 'text-purple' : 'text-green'}`}>
                {fmt(timeLeft)}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Wallet</span>
              <span className="detail-value mono">
                {currentItem.walletAddress.slice(0, 4)}...{currentItem.walletAddress.slice(-4)}
              </span>
            </div>
          </>
        )}
        {isDefault && (
          <div className="detail-row">
            <span className="detail-label">Status</span>
            <span className="detail-value text-muted">Default token (no queue)</span>
          </div>
        )}
        <a
          href={`https://dexscreener.com/solana/${currentToken}`}
          target="_blank"
          rel="noopener noreferrer"
          className="detail-link"
        >
          View on DexScreener -&gt;
        </a>
      </div>
    </div>
  );
}

function PromoteForm({ mounted }: { mounted: boolean }) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedTier, setSelectedTier] = useState<number>(STANDARD_PRICE);
  const [cooldownStatus, setCooldownStatus] = useState<{ inCooldown: boolean; message?: string } | null>(null);
  const [checkingCooldown, setCheckingCooldown] = useState(false);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { addToQueue } = useQueueStore();

  const valid = (a: string) => { try { new PublicKey(a); return true; } catch { return false; } };

  // Check cooldown when token changes (debounced)
  useEffect(() => {
    setCooldownStatus(null);
    setError('');

    if (!token.trim() || !valid(token.trim())) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(async () => {
      setCheckingCooldown(true);
      try {
        const response = await fetch(withAppBasePath('/api/queue/check-cooldown'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenMint: token.trim() }),
        });

        const data = await response.json();
        setCooldownStatus(data);

        // Auto-select Skip Cooldown tier if token is in cooldown
        if (data.inCooldown) {
          setSelectedTier(PRIORITY_DUPLICATE);
        }
      } catch (err) {
        console.error('Cooldown check error:', err);
      } finally {
        setCheckingCooldown(false);
      }
    }, 800); // 0.8s debounce

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [token]);

  const pay = async (amount: number) => {
    setError(''); setSuccess('');
    if (!publicKey) return setError('Connect wallet');
    if (!token.trim()) return setError('Enter address');
    if (!valid(token)) return setError('Invalid address');

    // Use cached cooldown status
    if (amount < PRIORITY_DUPLICATE && cooldownStatus?.inCooldown) {
      setError(cooldownStatus.message || 'Token in cooldown');
      return;
    }

    setLoading(true);
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(TREASURY_WALLET),
          lamports: Math.floor(amount * LAMPORTS_PER_SOL),
        })
      );
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      
      const result = await addToQueue(token.trim(), publicKey.toString(), amount, sig);

      setToken('');
      setCooldownStatus(null);

      // Show different message based on whether token is now active or queued
      if (result.processedImmediately) {
        if (amount === PRIORITY_PREMIUM) {
          setSuccess('Premium - Now showing!');
        } else if (amount === PRIORITY_DUPLICATE) {
          setSuccess('Override - Now showing!');
        } else if (amount === PRIORITY_BASIC) {
          setSuccess('Priority - Now showing!');
        } else {
          setSuccess('Now showing!');
        }
      } else {
        if (amount === PRIORITY_PREMIUM) {
          setSuccess('Premium added to queue!');
        } else if (amount === PRIORITY_DUPLICATE) {
          setSuccess('Override added to queue!');
        } else if (amount === PRIORITY_BASIC) {
          setSuccess('Priority added to queue!');
        } else {
          setSuccess('Added to queue!');
        }
      }

      setTimeout(() => setSuccess(''), 4000);
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : '';
      
      if (errorMsg.includes('recently queued') || errorMsg.includes('DUPLICATE_COOLDOWN')) {
        setError(errorMsg);
      } else if (errorMsg.includes('rejected')) {
        setError('Cancelled');
      } else {
        setError('Failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const isPayDisabled = () => {
    if (loading || !publicKey || checkingCooldown) return true;
    if (selectedTier < PRIORITY_DUPLICATE && cooldownStatus?.inCooldown) return true;
    return false;
  };

  return (
    <div className="section">
      <div className="section-title" style={{ color: 'var(--text-primary)', fontSize: '11px' }}>Promote Token</div>
      <div className="form">
        <input className="input" value={token} onChange={e => setToken(e.target.value)} placeholder="Token mint address..." />
        
        {/* Status Message - only show one at a time */}
        {(() => {
          // Priority: success > error > checking > cooldown > available
          if (success) {
            return <div className="msg success">{success}</div>;
          }
          if (error) {
            return <div className="msg error">{error}</div>;
          }
          if (checkingCooldown) {
            return (
              <div style={{
                fontSize: '0.7rem',
                color: 'var(--text-secondary)',
                padding: '0.5rem',
                background: 'var(--bg-hover)',
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginTop: '0.5rem'
              }}>
                <div style={{ width: '12px', height: '12px', border: '2px solid var(--text-secondary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                Checking availability...
              </div>
            );
          }
          if (cooldownStatus?.inCooldown) {
            return (
              <div style={{
                fontSize: '0.7rem',
                color: '#00bfff',
                padding: '0.5rem',
                background: 'rgba(0, 191, 255, 0.1)',
                border: '1px solid rgba(0, 191, 255, 0.2)',
                borderRadius: '4px',
                marginTop: '0.5rem'
              }}>
                Token in cooldown - only Skip Cooldown ({PRIORITY_DUPLICATE} SOL) available
              </div>
            );
          }
          if (cooldownStatus && !cooldownStatus.inCooldown && token.trim() && valid(token.trim())) {
            return (
              <div style={{
                fontSize: '0.7rem',
                color: 'var(--green)',
                padding: '0.5rem',
                background: 'rgba(57, 255, 20, 0.1)',
                border: '1px solid rgba(57, 255, 20, 0.2)',
                borderRadius: '4px',
                marginTop: '0.5rem'
              }}>
                Token available
              </div>
            );
          }
          return null;
        })()}
        
        <div style={{ margin: '1rem 0' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Select Tier:</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button
              style={{
                padding: '0.625rem',
                border: selectedTier === STANDARD_PRICE ? '2px solid var(--green)' : '1px solid var(--border-color)',
                background: selectedTier === STANDARD_PRICE ? 'rgba(57, 255, 20, 0.1)' : 'var(--bg-card)',
                borderRadius: '6px',
                cursor: cooldownStatus?.inCooldown ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
                opacity: cooldownStatus?.inCooldown ? 0.4 : 1,
                pointerEvents: cooldownStatus?.inCooldown ? 'none' : 'auto',
              }}
              onClick={() => setSelectedTier(STANDARD_PRICE)}
              disabled={cooldownStatus?.inCooldown}
            >
              <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.125rem', color: 'var(--text-primary)' }}>{STANDARD_PRICE} SOL</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Standard</div>
            </button>
            <button
              style={{
                padding: '0.625rem',
                border: selectedTier === PRIORITY_BASIC ? '2px solid var(--purple)' : '1px solid var(--border-color)',
                background: selectedTier === PRIORITY_BASIC ? 'rgba(191, 0, 255, 0.1)' : 'var(--bg-card)',
                borderRadius: '6px',
                cursor: cooldownStatus?.inCooldown ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
                opacity: cooldownStatus?.inCooldown ? 0.4 : 1,
                pointerEvents: cooldownStatus?.inCooldown ? 'none' : 'auto',
              }}
              onClick={() => setSelectedTier(PRIORITY_BASIC)}
              disabled={cooldownStatus?.inCooldown}
            >
              <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.125rem', color: 'var(--text-primary)' }}>! {PRIORITY_BASIC}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Priority</div>
            </button>
            <button
              style={{
                padding: '0.625rem',
                border: selectedTier === PRIORITY_DUPLICATE ? '2px solid #00bfff' : '1px solid var(--border-color)',
                background: selectedTier === PRIORITY_DUPLICATE ? 'rgba(0, 191, 255, 0.1)' : 'var(--bg-card)',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onClick={() => setSelectedTier(PRIORITY_DUPLICATE)}
            >
              <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.125rem', color: 'var(--text-primary)' }}>Override {PRIORITY_DUPLICATE}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Skip Cooldown</div>
              {cooldownStatus?.inCooldown && <div style={{ fontSize: '0.6rem', color: '#00bfff', marginTop: '0.25rem' }}>Required</div>}
            </button>
            <button
              style={{
                padding: '0.625rem',
                border: selectedTier === PRIORITY_PREMIUM ? '2px solid #ffd700' : '1px solid var(--border-color)',
                background: selectedTier === PRIORITY_PREMIUM ? 'rgba(255, 215, 0, 0.1)' : 'var(--bg-card)',
                borderRadius: '6px',
                cursor: cooldownStatus?.inCooldown ? 'not-allowed' : 'pointer',
                transition: 'all 0.2s',
                opacity: cooldownStatus?.inCooldown ? 0.4 : 1,
                pointerEvents: cooldownStatus?.inCooldown ? 'none' : 'auto',
              }}
              onClick={() => setSelectedTier(PRIORITY_PREMIUM)}
              disabled={cooldownStatus?.inCooldown}
            >
              <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.125rem', color: 'var(--text-primary)' }}>Premium {PRIORITY_PREMIUM}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Premium 1hr</div>
            </button>
          </div>
          <div style={{ 
            fontSize: '0.7rem', 
            color: 'var(--text-secondary)', 
            padding: '0.375rem', 
            background: 'var(--bg-hover)', 
            borderRadius: '4px', 
            textAlign: 'center'
          }}>
            {selectedTier === PRIORITY_PREMIUM && '1 hour display, highest priority'}
            {selectedTier === PRIORITY_DUPLICATE && '10 min, override 2hr cooldown'}
            {selectedTier === PRIORITY_BASIC && '10 min, priority queue'}
            {selectedTier === STANDARD_PRICE && '10 min, standard queue'}
          </div>
        </div>

        {mounted ? <WalletMultiButton /> : <div style={{ height: 38, background: 'var(--bg-card)', borderRadius: 6 }} />}

        <button
          className="btn btn-green"
          style={{
            background: selectedTier === PRIORITY_PREMIUM ? 'linear-gradient(135deg, #ffd700 0%, #ffed4e 100%)' : 
                       selectedTier === PRIORITY_DUPLICATE ? 'linear-gradient(135deg, #00bfff 0%, #5ce1e6 100%)' :
                       selectedTier === PRIORITY_BASIC ? 'linear-gradient(135deg, #bf00ff 0%, #dd00ff 100%)' : 
                       'linear-gradient(135deg, #39ff14 0%, #4fff29 100%)',
            color: '#000',
            fontWeight: '600',
            fontSize: '0.875rem',
            border: 'none',
            opacity: isPayDisabled() ? 0.5 : 1,
            cursor: isPayDisabled() ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s'
          }}
          onClick={() => pay(selectedTier)} 
          disabled={isPayDisabled()}
        >
          {loading ? 'Processing...' : checkingCooldown ? 'Checking...' : `Pay ${selectedTier} SOL`}
        </button>
        
        <div className="pricing-info" style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          <span>2hr cooldown per token</span>
          <span>{PRIORITY_DUPLICATE} SOL bypass</span>
        </div>
      </div>
    </div>
  );
}

function QueueList() {
  const { queue, currentItem } = useQueueStore();
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Update wait times every 10 seconds for real-time display
  useEffect(() => {
    if (queue.length === 0) return;
    const interval = setInterval(() => setNowMs(Date.now()), 10000);
    return () => clearInterval(interval);
  }, [queue.length]);

  // Calculate estimated wait times
  const getWaitTime = (index: number) => {
    const currentTimeLeft = currentItem?.expiresAt
      ? Math.max(0, currentItem.expiresAt - nowMs)
      : 0;

    // Sum up display durations of items before this one
    let totalWaitMs = currentTimeLeft;
    for (let i = 0; i < index; i++) {
      totalWaitMs += queue[i].displayDuration || DISPLAY_DURATION_STANDARD;
    }

    const mins = Math.floor(totalWaitMs / 60000);
    return mins < 60 ? `~${mins}m` : `~${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  const getPriorityLabel = (item: QueueItem) => {
    if (item.priorityLevel === 3) return 'Premium';
    if (item.priorityLevel === 2) return 'Override';
    if (item.priorityLevel === 1) return 'Priority';
    return '';
  };

  const getPriorityClass = (item: QueueItem) => {
    if (item.priorityLevel === 3) return 'premium';
    if (item.priorityLevel === 2) return 'duplicate';
    if (item.priorityLevel === 1) return 'priority';
    return '';
  };

  return (
    <div className="section">
      <div className="section-title">Queue ({queue.length})</div>
      {queue.length === 0 ? (
        <div className="queue-empty">No tokens waiting</div>
      ) : (
        <div className="queue-list">
          {queue.map((item, i) => (
            <div key={item.id} className={`queue-item ${getPriorityClass(item)}`}>
              <span className="n">#{i + 1}</span>
              <div className="queue-item-info">
                <span className="a">{item.tokenMint.slice(0, 4)}...{item.tokenMint.slice(-4)}</span>
                <span className="wait">{getWaitTime(i)}</span>
              </div>
              {item.isPriority && <span className="priority-icon">{getPriorityLabel(item)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
