import { createContext, useContext } from 'react';
import type { HomePayload } from './api';

export interface AppState {
  home: HomePayload | null;
  toast(message: string): void;
  askPrefill: { question: string; autoSend: boolean; token: number } | null;
  setAskPrefill(prefill: { question: string; autoSend: boolean } | null): void;
}

export const AppContext = createContext<AppState>({ home: null, toast: () => {}, askPrefill: null, setAskPrefill: () => {} });

export function useApp(): AppState {
  return useContext(AppContext);
}
