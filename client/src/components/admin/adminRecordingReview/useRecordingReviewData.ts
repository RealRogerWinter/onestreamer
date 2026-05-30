import { useState, useCallback, useRef, useEffect } from 'react';
import { PlaybackInfo, TimelineData } from './types';

interface UseRecordingReviewData {
  playbackInfo: PlaybackInfo | null;
  timeline: TimelineData | null;
  hasRecordings: boolean;
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  initialLoadComplete: boolean;
  fetchData: (isRefresh?: boolean) => Promise<void>;
}

// Owns the playback-info + timeline data plus its loading/error state. The data
// is loaded via the `makeApiCall` prop (the original component's mechanism):
// GET /admin/review/playback and GET /admin/review/timeline?days=7. Behavior is
// a verbatim move of the original inline fetchData + initial-mount effect.
export function useRecordingReviewData(
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>
): UseRecordingReviewData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfo | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [hasRecordings, setHasRecordings] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);

  // Fetch playback info and timeline on mount
  const fetchData = useCallback(
    async (isRefresh = false) => {
      try {
        // Only show loading spinner on initial load, not refreshes
        // This prevents unmounting the video element during refresh
        if (!isRefresh) {
          setLoading(true);
        }
        console.log(isRefresh ? 'Refreshing playback info...' : 'Fetching playback info...');

        // Fetch playback info
        const playbackResponse = await makeApiCall('/admin/review/playback');
        console.log('Playback response:', playbackResponse);
        if (playbackResponse.success && playbackResponse.hasRecordings) {
          console.log('Setting playback info:', playbackResponse.playback);
          setPlaybackInfo(playbackResponse.playback);
          setHasRecordings(true);
        } else {
          console.log('No recordings available');
          setHasRecordings(false);
        }

        // Fetch timeline data
        const timelineResponse = await makeApiCall('/admin/review/timeline?days=7');
        if (timelineResponse.success) {
          setTimeline(timelineResponse.timeline);
        }

        setError(null);
      } catch (err: any) {
        setError(err.message || 'Failed to load recording data');
      } finally {
        setLoading(false);
        setInitialLoadComplete(true);
      }
    },
    [makeApiCall]
  );

  // Only fetch on initial mount - use ref to prevent re-fetching when makeApiCall changes
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchData();
    }
  }, [fetchData]);

  return {
    playbackInfo,
    timeline,
    hasRecordings,
    loading,
    error,
    setError,
    initialLoadComplete,
    fetchData,
  };
}
