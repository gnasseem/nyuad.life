import { createContext, useContext } from 'react';
import type { Health, HomePayload, Profile } from './api';
import type { Theme } from './store';

export interface Prefill {
  question: string;
  autoSend: boolean;
}

export interface ProfileRequest {
  title?: string;
  reason?: string;
}

export interface AppState {
  home: HomePayload | null;
  health: Health | null;
  /** Why the board cannot be used right now (not set up, schema missing, wrong key...), or null when it works. */
  boardProblem: string | null;
  profile: Profile | null;
  setProfile(profile: Profile | null): void;
  /** Opens the "who are you" sheet; resolves true once a profile is saved, false if it was dismissed. */
  requestProfile(request?: ProfileRequest): Promise<boolean>;
  theme: Theme;
  setTheme(theme: Theme): void;
  toast(message: string): void;
  askPrefill: (Prefill & { token: number }) | null;
  setAskPrefill(prefill: Prefill | null): void;
  /** A question carried from Ask to the board's "ask students" form. */
  boardPrefill: string;
  setBoardPrefill(text: string): void;
  /** Shows confetti and a short card; the profile milestone and class-year moments use it. */
  celebrate(moment: { title: string; message: string; action?: string }): void;
}

export const AppContext = createContext<AppState>({
  home: null,
  health: null,
  boardProblem: null,
  profile: null,
  setProfile: () => {},
  requestProfile: async () => false,
  theme: 'system',
  setTheme: () => {},
  toast: () => {},
  askPrefill: null,
  setAskPrefill: () => {},
  boardPrefill: '',
  setBoardPrefill: () => {},
  celebrate: () => {},
});

export function useApp(): AppState {
  return useContext(AppContext);
}
