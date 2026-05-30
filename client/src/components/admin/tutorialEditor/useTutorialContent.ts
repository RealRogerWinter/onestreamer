import { useState, useEffect } from 'react';
import authService from '../../../services/AuthService';
import { API_URL, TabType, TabContent } from './types';
import {
  getDefaultAboutContent,
  getDefaultSupportContent,
  getDefaultTutorialContent,
  getDefaultTermsContent,
  getDefaultPrivacyContent,
} from './defaultContent';

const defaults = (): TabContent => ({
  about: getDefaultAboutContent(),
  support: getDefaultSupportContent(),
  tutorial: getDefaultTutorialContent(),
  terms: getDefaultTermsContent(),
  privacy: getDefaultPrivacyContent(),
});

export interface UseTutorialContent {
  content: TabContent;
  loading: boolean;
  saving: boolean;
  lastSaved: string | null;
  updateTabContent: (tab: TabType, value: string) => void;
  saveTutorialContent: () => Promise<void>;
}

export const useTutorialContent = (
  addLog: (message: string) => void
): UseTutorialContent => {
  const [content, setContent] = useState<TabContent>({
    about: '',
    support: '',
    tutorial: '',
    terms: '',
    privacy: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const loadTutorialContent = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/tutorial`);
      if (response.ok) {
        const data = await response.json();
        // Check if the data has the new structure with tabs
        if (data.tabs) {
          setContent({
            about: data.tabs.about || getDefaultAboutContent(),
            support: data.tabs.support || getDefaultSupportContent(),
            tutorial: data.tabs.tutorial || getDefaultTutorialContent(),
            terms: data.tabs.terms || getDefaultTermsContent(),
            privacy: data.tabs.privacy || getDefaultPrivacyContent(),
          });
        } else {
          // Fallback to old single content format
          setContent({
            about: getDefaultAboutContent(),
            support: getDefaultSupportContent(),
            tutorial: data.content || getDefaultTutorialContent(),
            terms: getDefaultTermsContent(),
            privacy: getDefaultPrivacyContent(),
          });
        }
        addLog('Tutorial content loaded successfully');
      } else {
        setContent(defaults());
        addLog('Using default tutorial content (no saved content found)');
      }
    } catch (error) {
      console.error('Failed to load tutorial:', error);
      setContent(defaults());
      addLog('Failed to load tutorial content - using defaults');
    } finally {
      setLoading(false);
    }
  };

  const saveTutorialContent = async () => {
    setSaving(true);
    try {
      const token = authService.getToken();
      const response = await fetch(`${API_URL}/api/tutorial`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ tabs: content }),
      });

      if (response.ok) {
        const now = new Date().toLocaleString();
        setLastSaved(now);
        addLog('Tutorial content saved successfully');
      } else {
        const errorData = await response.json();
        addLog(`Failed to save tutorial: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Failed to save tutorial:', error);
      addLog('Failed to save tutorial content');
    } finally {
      setSaving(false);
    }
  };

  const updateTabContent = (tab: TabType, value: string) => {
    setContent((prev) => ({
      ...prev,
      [tab]: value,
    }));
  };

  useEffect(() => {
    loadTutorialContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    content,
    loading,
    saving,
    lastSaved,
    updateTabContent,
    saveTutorialContent,
  };
};
