export type TabType = 'about' | 'support' | 'tutorial' | 'terms' | 'privacy';

export interface TabContent {
  about: string;
  support: string;
  tutorial: string;
  terms: string;
  privacy: string;
}

export interface TutorialEditorProps {
  addLog: (message: string) => void;
}

export const API_URL =
  process.env.REACT_APP_API_URL || process.env.REACT_APP_SERVER_URL || '';
