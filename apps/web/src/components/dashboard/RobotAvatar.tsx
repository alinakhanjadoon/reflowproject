'use client';

import React from 'react';

export type RobotState = 'idle' | 'running' | 'success' | 'error' | 'analyzing' | 'warning' | 'waiting';
export type RobotSize = 'mini' | 'badge' | 'card' | 'medium' | 'hero' | number;
export type RobotVariant = 'svg' | '3d';

export const REFLOW_MASCOT_URL = 'https://lh3.googleusercontent.com/aida-public/AB6AXuAqqQXscI_PGcUPnIEjqJO4o4tCjr3n8ei4FNQTOGtY2YofbORwfsA3kYJZoQR4tSoCihGF-qq0Rhz2yGZxWsdJPrii-KxoXwptkx3a4cd6ld3NEzEqi-Th98TtRDqgghPWrTeZPweB78Kp-E4jjZuNLynRaK-pK9ywVr9eHxSwZMDhezhDEU4nVhZHbXrCiq1djLvfl4rYhzitS2a0cFbiSMGbm3WLkSn00lDA6TJM';
export const REFLOW_MASCOT_INSPECTING_URL = 'https://lh3.googleusercontent.com/aida-public/AB6AXuCFrBgprv4VHGk3CBfZRM9F5uSqpTT4JWlmt0t19eg5E9m7xt_2DJyz8BjhAeI6mt3HsltWe0A4TVRPPOKXkdTwRnWtXaKlQGJ2hs966Hl8n-YzN-gp-_pzz9HdoCb-LmKu0uL3fYrm7QLpP-mgA6ghK5K5REwNtdoT7xFmYKgt4njWnViSlBf52bsk8PNWU3CmTCuh8dnBBQDfRmNN4y13a-UHmYHtwUwX8nxu4Jx7';

interface RobotAvatarProps {
  size?: RobotSize;
  state?: RobotState;
  variant?: RobotVariant;
  className?: string;
  style?: React.CSSProperties;
}

export function RobotAvatar({
  size = 'badge',
  state = 'idle',
  variant = '3d',
  className = '',
  style = {}
}: RobotAvatarProps) {
  const uid = React.useId().replace(/:/g, '');
  const [imgError, setImgError] = React.useState(false);
  // Dimensions
  let width = 34;
  let height = 38;
  if (size === 'mini') {
    width = 22;
    height = 25;
  } else if (size === 'badge') {
    width = 34;
    height = 38;
  } else if (size === 'card') {
    width = 64;
    height = 72;
  } else if (size === 'medium') {
    width = 96;
    height = 108;
  } else if (size === 'hero') {
    width = 240;
    height = 270;
  } else if (typeof size === 'number') {
    width = size;
    height = Math.round(size * 1.125);
  }

  // If 3d mascot variant is selected and image loads successfully
  if (variant === '3d' && !imgError && (size === 'card' || size === 'medium' || size === 'hero' || typeof size === 'number' || size === 'badge' || size === 'mini')) {
    return (
      <div
        className={`inline-flex items-center justify-center select-none flex-shrink-0 relative group ${className}`}
        style={{ width, height, ...style }}
        aria-hidden="true"
      >
        <img
          src={state === 'analyzing' ? REFLOW_MASCOT_INSPECTING_URL : REFLOW_MASCOT_URL}
          alt="ReFlow Assistant Mascot"
          className="w-full h-full object-contain filter drop-shadow-[0_4px_12px_rgba(6,182,212,0.35)] transition-transform duration-300 group-hover:scale-105"
          onError={() => setImgError(true)}
        />
        {state === 'running' && (
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-cyan-400 ring-2 ring-[#0b1326] animate-pulse" />
        )}
      </div>
    );
  }

  // Accent colors based on state
  let eyeColor = '#00f0ff';
  let earColor = '#60a5fa';

  if (state === 'error') {
    eyeColor = '#ef4444';
    earColor = '#dc2626';
  } else if (state === 'success') {
    eyeColor = '#10b981';
    earColor = '#059669';
  } else if (state === 'warning' || state === 'waiting') {
    eyeColor = '#fbbf24';
    earColor = '#d97706';
  } else if (state === 'analyzing') {
    eyeColor = '#a78bfa';
    earColor = '#8b5cf6';
  } else if (state === 'running') {
    eyeColor = '#38bdf8';
    earColor = '#2563eb';
  }

  return (
    <div
      className={`inline-flex items-center justify-center select-none flex-shrink-0 ${className}`}
      style={{ width, height, ...style }}
      aria-hidden="true"
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 320 360"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={`rbBody-${uid}`} x1="60" y1="40" x2="260" y2="340" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="65%" stopColor="#edf2fe" />
            <stop offset="100%" stopColor="#d9e3f8" />
          </linearGradient>
          <linearGradient id={`rbVisor-${uid}`} x1="100" y1="90" x2="220" y2="180" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0a1226" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>
          <filter id={`rbGlow-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Hovering Shadow */}
        <ellipse cx="160" cy="335" rx="55" ry="10" fill="#6366f1" filter="blur(6px)" opacity="0.35" />

        {/* Right Ear Pod */}
        <rect x="238" y="112" width="20" height="38" rx="8" fill={`url(#rbBody-${uid})`} stroke="#c7d2fe" strokeWidth="1.5" />
        <circle cx="248" cy="131" r="5" fill={earColor} />

        {/* Left Ear Pod */}
        <rect x="62" y="112" width="20" height="38" rx="8" fill={`url(#rbBody-${uid})`} stroke="#c7d2fe" strokeWidth="1.5" />
        <circle cx="72" cy="131" r="5" fill={earColor} />

        {/* Head Capsule */}
        <rect
          x="74"
          y="60"
          width="172"
          height="142"
          rx="71"
          fill={`url(#rbBody-${uid})`}
          stroke="#ffffff"
          strokeWidth="2.5"
        />

        {/* Sleek Dark Glass Visor */}
        <rect
          x="94"
          y="95"
          width="132"
          height="72"
          rx="36"
          fill={`url(#rbVisor-${uid})`}
          stroke="#38bdf8"
          strokeWidth="1.5"
          strokeOpacity="0.4"
        />

        {/* Visor Glare */}
        <path
          d="M106 112 C130 102 190 102 214 112"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.25"
        />

        {/* Dynamic Eyes based on State */}
        {state === 'running' ? (
          <>
            <circle cx="124" cy="131" r="6" fill={eyeColor} filter={`url(#rbGlow-${uid})`} />
            <circle cx="196" cy="131" r="6" fill={eyeColor} filter={`url(#rbGlow-${uid})`} />
            <circle cx="126" cy="129" r="2" fill="#ffffff" />
            <circle cx="198" cy="129" r="2" fill="#ffffff" />
          </>
        ) : state === 'analyzing' ? (
          <rect x="110" y="128" width="100" height="6" rx="3" fill={eyeColor} filter={`url(#rbGlow-${uid})`}>
            <animate attributeName="opacity" values="0.7;1;0.7" dur="1.2s" repeatCount="indefinite" />
          </rect>
        ) : state === 'error' ? (
          <>
            <line x1="116" y1="126" x2="132" y2="136" stroke={eyeColor} strokeWidth="4" strokeLinecap="round" filter={`url(#rbGlow-${uid})`} />
            <line x1="188" y1="136" x2="204" y2="126" stroke={eyeColor} strokeWidth="4" strokeLinecap="round" filter={`url(#rbGlow-${uid})`} />
          </>
        ) : (
          <>
            {/* Friendly Smiling Eye Arcs */}
            <path
              d="M114 133 C118 123 134 123 138 133"
              fill="none"
              stroke={eyeColor}
              strokeWidth="4"
              strokeLinecap="round"
              filter={`url(#rbGlow-${uid})`}
            />
            <path
              d="M182 133 C186 123 202 123 206 133"
              fill="none"
              stroke={eyeColor}
              strokeWidth="4"
              strokeLinecap="round"
              filter={`url(#rbGlow-${uid})`}
            />
          </>
        )}

        {/* Torso Capsule */}
        <path
          d="M110 205 C110 196 120 190 135 190 L185 190 C200 190 210 196 210 205 L220 280 C220 295 205 305 185 305 L135 305 C115 305 100 295 100 280 Z"
          fill={`url(#rbBody-${uid})`}
          stroke="#ffffff"
          strokeWidth="2"
        />

        {/* Chest Glow Reactor */}
        <circle cx="160" cy="245" r="14" fill="#0f172a" stroke="#cbd5e1" strokeWidth="1" />
        <circle cx="160" cy="245" r="8" fill={eyeColor} filter={`url(#rbGlow-${uid})`}>
          <animate attributeName="opacity" values="0.7;1;0.7" dur="2s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
  );
}

export default RobotAvatar;
