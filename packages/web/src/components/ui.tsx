import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/* ===========================================================================
   Icons
   ---------------------------------------------------------------------------
   Inline 16px strokes on a 24 grid, currentColor, no icon dependency. A sprite
   this small is cheaper to own than to install, and it guarantees every glyph
   shares the same weight as the type next to it.
   =========================================================================== */

type IconProps = { size?: number; className?: string };

const svg = (path: React.ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

export const IconChat = svg(<path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z" />);
export const IconDocs = svg(
  <>
    <path d="M14 3v5h5" />
    <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5Z" />
    <path d="M9 13h6M9 17h4" />
  </>,
);
export const IconCompare = svg(
  <>
    <rect x="3" y="4" width="7" height="16" rx="1.5" />
    <rect x="14" y="4" width="7" height="16" rx="1.5" />
  </>,
);
export const IconMetrics = svg(
  <>
    <path d="M3 20h18" />
    <path d="M6 20v-6M11 20V6M16 20v-9M21 20v-4" />
  </>,
);
export const IconSend = svg(<path d="M4 12l16-8-6 8 6 8-16-8Z" />);
export const IconStop = svg(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const IconPlus = svg(<path d="M12 5v14M5 12h14" />);
export const IconTrash = svg(
  <>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </>,
);
export const IconClose = svg(<path d="M6 6l12 12M18 6L6 18" />);
export const IconChevron = svg(<path d="M9 6l6 6-6 6" />);
export const IconCopy = svg(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 5H6a2 2 0 0 0-2 2v9" />
  </>,
);
export const IconCheck = svg(<path d="M5 12.5l4.5 4.5L19 7" />);
export const IconSearch = svg(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>,
);
export const IconTool = svg(
  <path d="M14.5 3.5a5 5 0 0 0-6.3 6.3l-4.6 4.6a2 2 0 0 0 0 2.8l1.2 1.2a2 2 0 0 0 2.8 0l4.6-4.6a5 5 0 0 0 6.3-6.3l-2.9 2.9-2.1-2.1 2.9-2.9Z" />,
);
export const IconSources = svg(
  <>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
    <path d="M8 7h6M8 11h6" />
  </>,
);
export const IconInfo = svg(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </>,
);
export const IconWarn = svg(
  <>
    <path d="M10.3 4.3 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 16.5h.01" />
  </>,
);
export const IconSidebar = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);
export const IconRefresh = svg(
  <>
    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
    <path d="M20 4v4.5h-4.5" />
  </>,
);
export const IconUpload = svg(
  <>
    <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </>,
);
export const IconSpark = svg(
  <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3Z" />,
);

/** Brand mark: three strands converging — several providers, one interface. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="6.5" fill="url(#pg)" />
      <path
        d="M6.5 6.5c3.6 0 3.6 5.5 7.2 5.5M6.5 12c3.6 0 3.6 0 7.2 0M6.5 17.5c3.6 0 3.6-5.5 7.2-5.5"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.92"
      />
      <circle cx="17.2" cy="12" r="2.1" fill="white" />
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#6366F1" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ===========================================================================
   Provider identity
   =========================================================================== */

/**
 * One colour per provider, read from the CSS custom properties so the palette
 * lives in exactly one place. The same hue marks a provider in the header dots,
 * the left edge of its messages, its comparison lane and its metrics row.
 */
export function providerColor(provider?: string): string {
  const known = ['anthropic', 'google', 'openai', 'groq', 'deepseek', 'local'];
  return known.includes(provider ?? '') ? `var(--p-${provider})` : 'var(--c-ink-4)';
}

export function ProviderDot({ provider, off, title }: { provider: string; off?: boolean; title?: string }) {
  return (
    <span
      className={`provider-dot${off ? ' off' : ''}`}
      style={off ? undefined : ({ '--dot': providerColor(provider) } as React.CSSProperties)}
      title={title ?? provider}
    />
  );
}

/* ===========================================================================
   Primitives
   =========================================================================== */

export function Badge({
  children,
  tone = 'default',
  title,
  mono,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'err' | 'accent' | 'solid';
  title?: string;
  mono?: boolean;
}) {
  return (
    <span className={`badge${tone === 'default' ? '' : ` ${tone}`}`} title={title} style={mono ? { fontFamily: 'var(--font-mono)' } : undefined}>
      {children}
    </span>
  );
}

export function Notice({
  level,
  children,
}: {
  level: 'info' | 'warn' | 'err';
  children: React.ReactNode;
}) {
  const Ico = level === 'err' || level === 'warn' ? IconWarn : IconInfo;
  return (
    <div className={`notice ${level}`} role={level === 'err' ? 'alert' : 'status'}>
      <Ico size={15} className="ico" />
      <div className="fill">{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="icon-wrap">{icon}</div>}
      <h4>{title}</h4>
      {hint && <div className="sm" style={{ maxWidth: 420 }}>{hint}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'err';
  title?: string;
}) {
  const color = tone === 'err' ? 'var(--c-err)' : tone === 'warn' ? 'var(--c-warn)' : tone === 'ok' ? 'var(--c-ok)' : undefined;
  return (
    <div className="stat" title={title}>
      <span className="label">{label}</span>
      <span className="metric-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

/** Copy-to-clipboard with the confirmation state people expect. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="ghost icon"
      title={done ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked; nothing useful to say */
        }
      }}
    >
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
}

/* ===========================================================================
   Toasts
   ---------------------------------------------------------------------------
   Errors that arrive while the user is looking elsewhere (a failed upload, a
   rejected request) need somewhere to go that is not an inline block halfway up
   a scrolled panel.
   =========================================================================== */

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'err';
  message: string;
}

const ToastContext = createContext<(level: Toast['level'], message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((level: Toast['level'], message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, level, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), level === 'err' ? 8000 : 4500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.level}`}>
            {toast.level === 'info' ? <IconInfo size={15} /> : <IconWarn size={15} />}
            <span className="fill">{toast.message}</span>
            <button className="ghost icon" onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}>
              <IconClose size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ===========================================================================
   Hooks
   =========================================================================== */

/** Grow a textarea to fit its content, up to the CSS max-height. */
export function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

/**
 * Follow the bottom of a scroll container while the user is already there, and
 * stop the moment they scroll up — auto-scrolling someone away from text they
 * are reading is the most common streaming-UI mistake.
 */
export function useStickyScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 90);
  }, []);

  useEffect(() => {
    if (!pinned) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  }, []);

  return { ref, pinned, onScroll, scrollToBottom };
}

/**
 * Subscribe to a media query.
 *
 * Panel visibility has to FOLLOW the layout, not be decided once at mount:
 * below the breakpoints the side panels become overlays, and an overlay left
 * open from a wider layout covers the thing the user came to read.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Format a timestamp as a short relative label, for dense lists. */
export function useRelativeTime(iso: string): string {
  return useMemo(() => {
    const then = new Date(iso).getTime();
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }, [iso]);
}
