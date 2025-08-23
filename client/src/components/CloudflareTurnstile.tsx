import React, { useEffect, useRef, useState } from 'react';

interface CloudflareTurnstileProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onError?: (error: string) => void;
  onExpire?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact';
  tabIndex?: number;
  action?: string;
  cData?: string;
  retry?: 'auto' | 'never';
  retryInterval?: number;
  refreshExpired?: 'auto' | 'manual' | 'never';
  appearance?: 'always' | 'execute' | 'interaction-only';
  language?: string;
}

declare global {
  interface Window {
    turnstile: {
      render: (element: HTMLElement | string, options: any) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId: string) => string | undefined;
      isExpired: (widgetId: string) => boolean;
    };
  }
}

const CloudflareTurnstile: React.FC<CloudflareTurnstileProps> = ({
  siteKey,
  onVerify,
  onError,
  onExpire,
  theme = 'auto',
  size = 'normal',
  tabIndex = 0,
  action,
  cData,
  retry = 'auto',
  retryInterval = 8000,
  refreshExpired = 'auto',
  appearance = 'always',
  language
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [widgetId, setWidgetId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let timeoutId: NodeJS.Timeout;
    let retryCount = 0;
    const maxRetries = 50; // Try for up to 5 seconds

    const initTurnstile = () => {
      if (!mounted) return;
      
      if (window.turnstile && containerRef.current) {
        try {
          console.log('Rendering Turnstile widget with site key:', siteKey);
          const id = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            theme,
            size,
            tabindex: tabIndex,
            action,
            cdata: cData,
            callback: (token: string) => {
              if (mounted) {
                onVerify(token);
              }
            },
            'error-callback': () => {
              if (mounted && onError) {
                onError('Turnstile verification failed');
              }
            },
            'expired-callback': () => {
              if (mounted && onExpire) {
                onExpire();
              }
            },
            retry,
            'retry-interval': retryInterval,
            'refresh-expired': refreshExpired,
            appearance,
            language
          });
          
          if (mounted) {
            setWidgetId(id);
            setIsLoading(false);
          }
        } catch (error) {
          console.error('Failed to render Turnstile widget:', error);
          if (mounted) {
            setIsLoading(false);
            if (onError) {
              onError('Failed to load Turnstile widget');
            }
          }
        }
      } else {
        // Retry after a short delay if Turnstile is not yet loaded
        retryCount++;
        if (retryCount < maxRetries) {
          console.log(`Turnstile not ready yet, retrying... (${retryCount}/${maxRetries})`);
          timeoutId = setTimeout(initTurnstile, 100);
        } else {
          console.error('Turnstile failed to load after maximum retries');
          setIsLoading(false);
          if (onError) {
            onError('Turnstile widget failed to load');
          }
        }
      }
    };

    initTurnstile();

    return () => {
      mounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch (error) {
          console.error('Failed to remove Turnstile widget:', error);
        }
      }
    };
  }, [siteKey, theme, size, tabIndex, action, cData, retry, retryInterval, refreshExpired, appearance, language]);

  const reset = () => {
    if (widgetId && window.turnstile) {
      window.turnstile.reset(widgetId);
    }
  };

  const getResponse = (): string | undefined => {
    if (widgetId && window.turnstile) {
      return window.turnstile.getResponse(widgetId);
    }
    return undefined;
  };

  return (
    <div className="turnstile-container">
      {isLoading && (
        <div className="turnstile-loading" style={{ 
          padding: '10px', 
          textAlign: 'center',
          color: '#666'
        }}>
          Loading security verification...
        </div>
      )}
      <div ref={containerRef} style={{ display: isLoading ? 'none' : 'block' }} />
    </div>
  );
};

export default CloudflareTurnstile;