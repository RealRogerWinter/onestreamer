import React, { useState, useEffect, useCallback, useRef } from 'react';
import ClipCard from './ClipCard';
import ClipsHeader from './ClipsHeader';
import '../../styles/Clips.css';

interface Clip {
  clip_id: string;
  title: string;
  description?: string;
  duration_ms: number;
  view_count: number;
  thumbnail_path?: string;
  creator_username?: string;
  streamer_username?: string;
  created_at: string;
  status: string;
}

interface ClipsResponse {
  success: boolean;
  clips: Clip[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const ClipsGallery: React.FC = () => {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [sortBy, setSortBy] = useState<'recent' | 'views'>('recent');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1); // Reset to first page on search change
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    fetchClips();
  }, [page, sortBy, debouncedSearch]);

  const fetchClips = async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        page: page.toString(),
        limit: '20',
        sort: sortBy
      });

      if (debouncedSearch.trim()) {
        params.append('search', debouncedSearch.trim());
      }

      const response = await fetch(`/api/clips?${params.toString()}`);
      const data: ClipsResponse = await response.json();

      if (data.success) {
        setClips(data.clips);
        setTotalPages(data.pagination.totalPages);
      } else {
        setError('Failed to load clips');
      }
    } catch (err) {
      console.error('Error fetching clips:', err);
      setError('Failed to load clips');
    } finally {
      setLoading(false);
    }
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSortBy(e.target.value as 'recent' | 'views');
    setPage(1); // Reset to first page on sort change
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  };

  const clearSearch = () => {
    setSearchQuery('');
    searchInputRef.current?.focus();
  };

  if (loading && clips.length === 0) {
    return (
      <>
        <ClipsHeader />
        <div className="clips-page">
          <div className="clips-loading">
            <div className="clips-loading-spinner"></div>
            <p>Loading clips...</p>
          </div>
        </div>
      </>
    );
  }

  if (error && clips.length === 0) {
    return (
      <>
        <ClipsHeader />
        <div className="clips-page">
          <div className="clips-error">
            <p>{error}</p>
            <button onClick={fetchClips}>Try Again</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <ClipsHeader />
      <div className="clips-page">

      <div className="clips-controls">
        <div className="clips-search-container">
          <input
            ref={searchInputRef}
            type="text"
            className="clips-search-input"
            placeholder="Search clips..."
            value={searchQuery}
            onChange={handleSearchChange}
          />
          {searchQuery && (
            <button
              className="clips-search-clear"
              onClick={clearSearch}
              aria-label="Clear search"
            >
              x
            </button>
          )}
        </div>
        <select
          className="clips-sort-select"
          value={sortBy}
          onChange={handleSortChange}
        >
          <option value="recent">Most Recent</option>
          <option value="views">Most Viewed</option>
        </select>
      </div>

      {clips.length === 0 ? (
        <div className="clips-empty">
          <div className="clips-empty-icon">{debouncedSearch ? '🔍' : '🎬'}</div>
          {debouncedSearch ? (
            <>
              <p>No clips found for "{debouncedSearch}"</p>
              <p>Try a different search term</p>
              <button className="clips-clear-search-btn" onClick={clearSearch}>
                Clear Search
              </button>
            </>
          ) : (
            <>
              <p>No clips yet</p>
              <p>Be the first to create a clip from a stream!</p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="clips-grid">
            {clips.map((clip) => (
              <ClipCard key={clip.clip_id} clip={clip} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="clips-pagination">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </button>
              <span className="page-info">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      </div>
    </>
  );
};

export default ClipsGallery;
