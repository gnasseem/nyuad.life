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
  /** Shows confetti and a short card; the profile milestone and class-year moments use it. */
  celebrate(moment: { title: string; message: string; action?: string }): void;
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
  celebrate: () => {},
});

export function useApp(): AppState {
  return useContext(AppContext);
}
