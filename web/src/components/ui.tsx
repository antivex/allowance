import { useState, type ReactNode } from 'react';
import { STATUS_LABEL, STATUS_TONE } from '../format';
import type { Decision, DecisionSource, PurchaseStatus } from '../types';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5l7 2.6v5.7c0 4.4-3 7.8-7 9.2-4-1.4-7-4.8-7-9.2V5.1l7-2.6z" fill="#fff" />
      <path d="M8.8 12.1l2.3 2.3 4.2-4.6" stroke="#3451d1" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PayPalWord() {
  return (
    <span className="paypal-word">
      <span>Pay</span>
      <span>Pal</span>
    </span>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' | 'brand'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

const STATUS_ICON: Record<PurchaseStatus, string> = {
  processing: '…',
  paid: '✓',
  on_hold: '⏸',
  settling: '…',
  denied: '✕',
  expired: '⌛',
  blocked: '⛔',
  failed: '!',
};

export function StatusPill({ status }: { status: PurchaseStatus }) {
  return (
    <Pill tone={STATUS_TONE[status]}>
      <span aria-hidden="true">{STATUS_ICON[status]}</span>
      {STATUS_LABEL[status]}
    </Pill>
  );
}

export function SourceTag({ source, decision }: { source: DecisionSource; decision: Decision }) {
  if (source === 'ai') return <span className="tag ai" title="The AI review made this decision stricter than the rules">✦ AI {decision === 'block' ? 'blocked' : 'flagged'}</span>;
  if (source === 'ai_unavailable') return <span className="tag" title="The AI review did not answer, so this waits for you">AI offline</span>;
  return <span className="tag" title="Decided by your rules">Rules</span>;
}

export function CopyButton({ text, label = 'Copy', className = 'btn small' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ animation: 'spin 0.8s linear infinite' }}>
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
