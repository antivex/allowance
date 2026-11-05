import type { PurchaseStatus } from './types';

const money = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, currency: string): string {
  let formatter = money.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    money.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDateTime(iso);
}

export function timeLeft(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'releasing now';
  // Rounded down, like a countdown: a hold of 24 hours reads 23 h 59 min, never 24 h 1 min on a clock a little behind.
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export const STATUS_LABEL: Record<PurchaseStatus, string> = {
  processing: 'Processing',
  paid: 'Paid',
  on_hold: 'Waiting for you',
  settling: 'Settling',
  denied: 'Denied',
  expired: 'Expired',
  blocked: 'Blocked',
  failed: 'Not paid',
};

export const STATUS_TONE: Record<PurchaseStatus, 'ok' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  processing: 'info',
  paid: 'ok',
  on_hold: 'warn',
  settling: 'info',
  denied: 'neutral',
  expired: 'neutral',
  blocked: 'bad',
  failed: 'bad',
};

export function shortId(id: string | null): string {
  if (!id) return '';
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
