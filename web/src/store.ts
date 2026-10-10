/**
 * Per-device state in localStorage: theme, past conversations, the helper profile, the anonymous asker key and the
 * contact last used. The conversation open on Ask is per tab, in sessionStorage.
 */
import type { Rules, Want } from '../../lib/schedule.ts';
import { normalizeRules, sessionHalf } from '../../lib/schedule.ts';
import type { ChatTurn, Confidence, ContactKind, Profile, Redirect, SourceCard } from './api';

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  sources?: SourceCard[];
  confidence?: Confidence | null;
  redirect?: Redirect;
  status?: string;
  error?: string;
  /** The server's code for the error, so the page can offer the fix (signing in to ChatGPT again, for one). */
  errorCode?: string;
  pending?: boolean;
  /** The answer stopped before it finished: the time or length limit, a dropped connection, or the page was left. */
  truncated?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

const CONVERSATIONS_KEY = 'room.conversations';
const THEME_KEY = 'room.theme';
const PROFILE_KEY = 'room.profile';
const KEY_KEY = 'room.key';
const ANNOUNCED_KEY = 'room.announced';
const CONTACT_KEY = 'room.contact';
/** In sessionStorage: one per tab, gone when the tab closes. */
const ACTIVE_KEY = 'room.active';
const PLAN_KEY = 'room.plan';
const ONBOARDED_KEY = 'room.onboarded';
const SIDEBAR_KEY = 'room.sidebar';
const MAX_CONVERSATIONS = 60;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable
  }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ---------- Conversations ---------- */

const conversationListeners = new Set<() => void>();

export function onConversationsChange(listener: () => void): () => void {
  conversationListeners.add(listener);
  return () => conversationListeners.delete(listener);
}

function notify(): void {
  conversationListeners.forEach((listener) => listener());
}

export function loadConversations(): Conversation[] {
  return read<Conversation[]>(CONVERSATIONS_KEY, []);
}

/**
 * Saves a conversation as it stands. An answer still coming in is saved as cut short, so a conversation saved the moment
 * a question is sent, or as the page is left mid-answer, comes back with its "Ask again" rather than a spinner.
 */
export function saveConversation(conversation: Conversation): void {
  const list = loadConversations().filter((entry) => entry.id !== conversation.id);
  const cleaned: Conversation = {
    ...conversation,
    messages: conversation.messages.map(({ status: _status, pending, ...rest }) => (pending ? { ...rest, truncated: true } : rest)),
  };
  if (cleaned.messages.length === 0) return;
  list.unshift(cleaned);
  write(CONVERSATIONS_KEY, list.slice(0, MAX_CONVERSATIONS));
  notify();
}

export function deleteConversation(id: string): void {
  write(CONVERSATIONS_KEY, loadConversations().filter((entry) => entry.id !== id));
  if (loadActiveConversation() === id) setActiveConversation(null);
  notify();
}

export function clearConversations(): void {
  write(CONVERSATIONS_KEY, []);
  setActiveConversation(null);
  notify();
}

/** The conversation open on Ask in this tab, so going to another page and back to Ask finds it again. */
export function loadActiveConversation(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

/** Sets the conversation Ask returns to; null ("New question") makes Ask start empty. */
export function setActiveConversation(id: string | null): void {
  if (loadActiveConversation() === id) return;
  try {
    if (id) sessionStorage.setItem(ACTIVE_KEY, id);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    // storage unavailable: Ask simply starts empty
  }
  notify();
}

export function toHistory(messages: Message[]): ChatTurn[] {
  return messages.filter((message) => !message.pending && !message.error && message.content && !message.redirect).map((message) => ({ role: message.role, content: message.content }));
}

/* ---------- Identity ---------- */

export function loadProfile(): Profile | null {
  return read<Profile | null>(PROFILE_KEY, null);
}

export function saveProfile(profile: Profile | null): void {
  if (profile) write(PROFILE_KEY, profile);
  else {
    try {
      localStorage.removeItem(PROFILE_KEY);
    } catch {
      // ignore
    }
  }
}

export function saveAccountKey(key: string): void { localStorage.setItem(KEY_KEY, key); }

/** A random key that ties questions and notices to this browser without asking who you are. */
export function askerKey(): string {
  let key = '';
  try {
    key = localStorage.getItem(KEY_KEY) ?? '';
  } catch {
    // ignore
  }
  if (!/^[a-z0-9-]{8,64}$/.test(key)) {
    key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : uid() + uid();
    try {
      localStorage.setItem(KEY_KEY, key);
    } catch {
      // ignore
    }
  }
  return key;
}

/** Ids of the notices posted from this browser, so they show a Remove button. */
export function loadAnnounced(): string[] {
  return read<string[]>(ANNOUNCED_KEY, []);
}

export function saveAnnounced(ids: string[]): void {
  write(ANNOUNCED_KEY, ids.slice(-50));
}

/** The contact method from the last offer or listing, so the next one starts filled in. */
export function loadContact(): { contactKind: ContactKind; contact: string } {
  return read(CONTACT_KEY, { contactKind: 'whatsapp' as ContactKind, contact: '' });
}

export function saveContact(value: { contactKind: ContactKind; contact: string }): void {
  write(CONTACT_KEY, value);
}

/** Clears local preferences and history. Keep the browser key so this browser can reclaim its existing NetID. */
export function forgetDevice(removeIdentity = false): void {
  for (const key of [CONVERSATIONS_KEY, THEME_KEY, PROFILE_KEY, ...(removeIdentity ? [KEY_KEY] : []), ANNOUNCED_KEY, CONTACT_KEY, PLAN_KEY, ONBOARDED_KEY, SIDEBAR_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  setActiveConversation(null);
  notify();
}

/* ---------- Theme ---------- */

/** Light or dark. The device's setting picks the first one; after that it is whatever the student chose. */
export type Theme = 'light' | 'dark';

export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // storage unavailable: fall back to the device
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Shows a theme; `remember` keeps it for next time (a choice, not the device's default). */
export function applyTheme(theme: Theme, remember = false): void {
  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]:not([media])')?.setAttribute('content', theme === 'dark' ? '#0a1130' : '#eef1f6');
}

/* ---------- First visit and layout ---------- */

/** Whether this browser has seen the welcome tour. */
export function loadOnboarded(): boolean {
  return read<boolean>(ONBOARDED_KEY, false) === true;
}

export function saveOnboarded(): void {
  write(ONBOARDED_KEY, true);
}

/** Whether the conversation list beside Ask is folded away on a wide screen. */
export function loadSidebarClosed(): boolean {
  return read<boolean>(SIDEBAR_KEY, false) === true;
}

export function saveSidebarClosed(closed: boolean): void {
  write(SIDEBAR_KEY, closed);
}

/** The schedule being built on Plan: its term, the courses wanted and the rules. */
export interface PlanMessage { role: 'user' | 'assistant'; text: string }

export interface SavedPlan {
  term: string;
  wants: Array<Want & { label: string }>;
  chat?: PlanMessage[];
  rules: Rules;
}

/** The saved plan, from any version of the page: rules it no longer has (the old lunch break) are dropped. */
export function loadPlan(): SavedPlan {
  const saved = read<Partial<SavedPlan>>(PLAN_KEY, {});
  const wants = Array.isArray(saved.wants) ? saved.wants.filter((want) => want && typeof want.id === 'string' && Array.isArray(want.codes)) : [];
  const chat = Array.isArray(saved.chat) ? saved.chat.filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string').slice(-24) : [];
  return {
    term: typeof saved.term === 'string' ? saved.term : '',
    wants: wants.map((want) => ({
      id: want.id,
      label: String(want.label ?? ''),
      codes: want.codes.map(String),
      sessions: Array.isArray(want.sessions) ? [...new Set(want.sessions.map(sessionHalf).filter((half): half is '71' | '72' => !!half))] : [],
    })),
    rules: normalizeRules(saved.rules),
    chat: chat.map((entry) => ({ role: entry.role, text: entry.text.slice(0, 1200) })),
  };
}

export function savePlan(plan: SavedPlan): void {
  write(PLAN_KEY, plan);
}
