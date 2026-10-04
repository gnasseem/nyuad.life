/** Per-device state in localStorage: theme, past conversations, the helper profile, the anonymous asker key and the contact last used. */
import type { ChatTurn, Confidence, ContactKind, Profile, Redirect, SourceCard } from './api';

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  sources?: SourceCard[];
  followups?: string[];
  confidence?: Confidence | null;
  redirect?: Redirect;
  status?: string;
  error?: string;
  /** The server's code for the error, so the page can offer the fix (signing in to ChatGPT again, for one). */
  errorCode?: string;
  pending?: boolean;
  /** The answer stopped before it finished: the time or length limit, or a dropped connection. */
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

export function saveConversation(conversation: Conversation): void {
  const list = loadConversations().filter((entry) => entry.id !== conversation.id);
  const cleaned: Conversation = {
    ...conversation,
    messages: conversation.messages.filter((message) => !message.pending && !message.error).map(({ status: _status, ...rest }) => rest),
  };
  if (cleaned.messages.length === 0) return;
  list.unshift(cleaned);
  write(CONVERSATIONS_KEY, list.slice(0, MAX_CONVERSATIONS));
  notify();
}

export function deleteConversation(id: string): void {
  write(CONVERSATIONS_KEY, loadConversations().filter((entry) => entry.id !== id));
  notify();
}

export function clearConversations(): void {
  write(CONVERSATIONS_KEY, []);
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

/** Removes everything this site keeps in the browser: profile, conversations, the anonymous key, the contact and the theme. */
export function forgetDevice(): void {
  for (const key of [CONVERSATIONS_KEY, THEME_KEY, PROFILE_KEY, KEY_KEY, ANNOUNCED_KEY, CONTACT_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  notify();
}

/* ---------- Theme ---------- */

export type Theme = 'light' | 'dark' | 'system';

export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
