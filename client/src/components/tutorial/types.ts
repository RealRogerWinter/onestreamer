export type TabType = 'about' | 'support' | 'tutorial' | 'terms' | 'privacy';

export interface TabContent {
  about: string;
  support: string;
  tutorial: string;
  terms: string;
  privacy: string;
}

export interface TutorialProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTab?: TabType;
}
