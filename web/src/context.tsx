import { createContext, useContext } from 'react';
import type { ChatGPTStatus, Health, Profile, QuestionWithAnswers } from './api';
import type { Theme } from './store';

export interface Prefill {
  question: string;
  autoSend: boolean;
}

export interface ProfileRequest {
  title?: string;
  reason?: string;
}

export interface StudentAnswers {
  questions: Map<string, QuestionWithAnswers>;
  seen: Record<string, number>;
  /** Counts these questions' answers as read. */
  markSeen(ids: string[]): void;
  refresh(): void;
}

export interface AppState {
  health: Health | null;
  /** Why the board cannot be used right now (not set up, schema missing, wrong key...), or null when it works. */
  boardProblem: string | null;
  profile: Profile | null;
  setProfile(profile: Profile | null): void;
  /** Opens the details sheet; resolves true once a profile is saved, false if it was dismissed. */
  requestProfile(request?: ProfileRequest): Promise<boolean>;
  theme: Theme;
  setTheme(theme: Theme): void;
  toast(message: string): void;
  askPrefill: (Prefill & { token: number }) | null;
  setAskPrefill(prefill: Prefill | null): void;
  /** The questions this browser put to students from Ask, with their answers, and how many of those were seen. */
  students: StudentAnswers;
  /** Sign in with ChatGPT for this browser; null until the server has answered. */
  chatgpt: ChatGPTStatus | null;
  refreshChatGPT(): void;
  /** Admin mode is on in this browser (an HttpOnly cookie the server checks); shows remove buttons everywhere. */
  admin: boolean;
  refreshAdmin(): void;
}

export const AppContext = createContext<AppState>({
  health: null,
  boardProblem: null,
  profile: null,
  setProfile: () => {},
  requestProfile: async () => false,
  theme: 'light',
  setTheme: () => {},
  toast: () => {},
  askPrefill: null,
  setAskPrefill: () => {},
  students: { questions: new Map(), seen: {}, markSeen: () => {}, refresh: () => {} },
  chatgpt: null,
  refreshChatGPT: () => {},
  admin: false,
  refreshAdmin: () => {},
});

export function useApp(): AppState {
  return useContext(AppContext);
}
