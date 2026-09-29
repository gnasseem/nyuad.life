/** Per-device state kept in localStorage: theme, past conversations. Everything degrades gracefully when storage is unavailable. */
import type { ChatTurn, SourceCard } from './api';

export interface Message {
  id: string;
  role: 'user' | 'model';
  content: string;
  sources?: SourceCard[];
  followups?: string[];
  status?: string;
  error?: string;
  pending?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

const CONVERSATIONS_KEY = 'ror.conversations';
const THEME_KEY = 'ror.theme';
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
}

export function deleteConversation(id: string): void {
  write(CONVERSATIONS_KEY, loadConversations().filter((entry) => entry.id !== id));
}

export function clearConversations(): void {
  write(CONVERSATIONS_KEY, []);
}

export function toHistory(messages: Message[]): ChatTurn[] {
  return messages.filter((message) => !message.pending && !message.error && message.content).map((message) => ({ role: message.role, content: message.content }));
}

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
