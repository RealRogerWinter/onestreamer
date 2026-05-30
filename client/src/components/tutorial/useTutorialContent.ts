import { useState, useEffect } from 'react';
import { TabContent } from './types';
import {
  getDefaultAboutContent,
  getDefaultSupportContent,
  getDefaultTutorialContent,
  getDefaultTermsContent,
  getDefaultPrivacyContent,
} from './defaultContent';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

const buildDefaults = (): TabContent => ({
  about: getDefaultAboutContent(),
  support: getDefaultSupportContent(),
  tutorial: getDefaultTutorialContent(),
  terms: getDefaultTermsContent(),
  privacy: getDefaultPrivacyContent(),
});

interface UseTutorialContentResult {
  content: TabContent;
  loading: boolean;
  error: string | null;
}

// Owns the fetch + fallback logic for tutorial/help content. Fires once each
// time `isOpen` flips, mirroring the original component's effect exactly.
export const useTutorialContent = (isOpen: boolean): UseTutorialContentResult => {
  const [content, setContent] = useState<TabContent>({
    about: '',
    support: '',
    tutorial: '',
    terms: '',
    privacy: '',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadTutorialContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const loadTutorialContent = async () => {
    setLoading(true);
    setError(null);

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
      } else {
        setContent(buildDefaults());
      }
    } catch (err) {
      console.error('Failed to load tutorial:', err);
      setContent(buildDefaults());
    } finally {
      setLoading(false);
    }
  };

  return { content, loading, error };
};
