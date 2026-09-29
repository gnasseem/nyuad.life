import { createContext, useContext } from 'react';
import type { Health, HomePayload, Profile } from './api';

export interface Prefill {
  question: string;
  autoSend: boolean;
}

export interface AppState {
  home: HomePayload | null;
  health: Health | null;
  profile: Profile | null;
  setProfile(profile: Profile | null): void;
  toast(message: string): void;
  askPrefill: (Prefill & { token: number }) | null;
  setAskPrefill(prefill: Prefill | null): void;
  /** A question carried from Ask to the board's "ask students" form. */
  boardPrefill: string;
  setBoardPrefill(text: string): void;
}

export const AppContext = createContext<AppState>({
  home: null,
  health: null,
  profile: null,
  setProfile: () => {},
  toast: () => {},
  askPrefill: null,
  setAskPrefill: () => {},
  boardPrefill: '',
  setBoardPrefill: () => {},
});

export function useApp(): AppState {
  return useContext(AppContext);
}
