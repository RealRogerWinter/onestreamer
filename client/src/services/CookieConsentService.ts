import * as CookieConsent from 'vanilla-cookieconsent';

export type ConsentCategory = 'necessary' | 'functional' | 'analytics' | 'marketing';

interface ConsentState {
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}

class CookieConsentService {
  private static instance: CookieConsentService;
  private consentState: ConsentState = {
    necessary: true, // Always true
    functional: false,
    analytics: false,
    marketing: false
  };
  private initialized: boolean = false;

  private constructor() {}

  static getInstance(): CookieConsentService {
    if (!CookieConsentService.instance) {
      CookieConsentService.instance = new CookieConsentService();
    }
    return CookieConsentService.instance;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    CookieConsent.run({
      categories: {
        necessary: {
          enabled: true,
          readOnly: true
        },
        functional: {
          enabled: false
        },
        analytics: {
          enabled: false,
          autoClear: {
            cookies: [
              {
                name: /^_ga/   // Google Analytics cookies
              },
              {
                name: '_gid'   // Google Analytics cookie
              }
            ]
          },
          services: {
            googleAnalytics: {
              label: 'Google Analytics',
              onAccept: () => {
                this.loadGoogleAnalytics();
              },
              onReject: () => {
                this.removeGoogleAnalytics();
              }
            }
          }
        },
        marketing: {
          enabled: false
        }
      },

      language: {
        default: 'en',
        autoDetect: 'browser',
        translations: {
          en: {
            consentModal: {
              title: 'We use cookies!',
              description: 'We use cookies to enhance your experience, analyze site traffic, and remember your preferences. Please choose which cookies you allow.',
              acceptAllBtn: 'Accept all',
              acceptNecessaryBtn: 'Reject all',
              showPreferencesBtn: 'Manage preferences',
              footer: '<a href="#" data-cc-link="privacy">Privacy Policy</a> | <a href="#" data-cc-link="terms">Terms of Service</a>'
            },
            preferencesModal: {
              title: 'Cookie Preferences',
              acceptAllBtn: 'Accept all',
              acceptNecessaryBtn: 'Reject all',
              savePreferencesBtn: 'Save preferences',
              closeIconLabel: 'Close modal',
              serviceCounterLabel: 'Service|Services',
              sections: [
                {
                  title: 'Cookie Usage',
                  description: 'We use cookies to ensure the basic functionalities of the website and to enhance your online experience. You can choose for each category to opt-in/out whenever you want.'
                },
                {
                  title: 'Strictly Necessary Cookies <span class="pm__badge">Always Enabled</span>',
                  description: 'These cookies are essential for the proper functioning of the website. They enable core features like authentication and security.',
                  linkedCategory: 'necessary'
                },
                {
                  title: 'Functionality Cookies',
                  description: 'These cookies allow the website to remember choices you make (such as your volume settings, stream preferences, and UI settings) to provide enhanced, more personalized features.',
                  linkedCategory: 'functional',
                  cookieTable: {
                    headers: {
                      name: 'Cookie',
                      domain: 'Domain',
                      duration: 'Duration',
                      description: 'Description'
                    },
                    body: [
                      {
                        name: 'onestreamer_volume',
                        domain: window.location.hostname,
                        duration: '1 year',
                        description: 'Remembers your preferred volume level'
                      },
                      {
                        name: 'onestreamer_muted',
                        domain: window.location.hostname,
                        duration: '1 year',
                        description: 'Remembers your mute preference'
                      },
                      {
                        name: 'onestreamer_settings',
                        domain: window.location.hostname,
                        duration: '1 year',
                        description: 'Stores your streamer settings'
                      },
                      {
                        name: 'onestreamer_audio_settings',
                        domain: window.location.hostname,
                        duration: '1 year',
                        description: 'Stores your audio configuration preferences'
                      },
                      {
                        name: 'onestreamer_video_settings',
                        domain: window.location.hostname,
                        duration: '1 year',
                        description: 'Stores your video quality preferences'
                      }
                    ]
                  }
                },
                {
                  title: 'Analytics & Performance Cookies',
                  description: 'These cookies help us understand how visitors interact with our website by collecting and reporting information anonymously.',
                  linkedCategory: 'analytics',
                  cookieTable: {
                    headers: {
                      name: 'Cookie',
                      domain: 'Domain',
                      duration: 'Duration',
                      description: 'Description'
                    },
                    body: [
                      {
                        name: '_ga',
                        domain: '.onestreamer.live',
                        duration: '2 years',
                        description: 'Google Analytics: Distinguishes unique users'
                      },
                      {
                        name: '_ga_*',
                        domain: '.onestreamer.live',
                        duration: '2 years',
                        description: 'Google Analytics: Maintains session state'
                      },
                      {
                        name: '_gid',
                        domain: '.onestreamer.live',
                        duration: '24 hours',
                        description: 'Google Analytics: Distinguishes users'
                      }
                    ]
                  }
                },
                {
                  title: 'Marketing & Advertising Cookies',
                  description: 'These cookies are used to track visitors across websites to display ads that are relevant and engaging. We currently do not use marketing cookies.',
                  linkedCategory: 'marketing'
                },
                {
                  title: 'More information',
                  description: 'For any queries in relation to our policy on cookies and your choices, please <a href="/contact">contact us</a>.'
                }
              ]
            }
          }
        }
      },

      guiOptions: {
        consentModal: {
          layout: 'box wide',
          position: 'bottom center',
          equalWeightButtons: true,
          flipButtons: false
        },
        preferencesModal: {
          layout: 'box',
          position: 'right',
          equalWeightButtons: true,
          flipButtons: false
        }
      },

      onFirstConsent: () => {
        console.log('Cookie consent: First consent given');
      },

      onConsent: () => {
        this.updateConsentState();
      },

      onChange: () => {
        this.updateConsentState();
      }
    });

    // Update initial consent state
    this.updateConsentState();

    // Add event listeners for privacy and terms links
    setTimeout(() => {
      this.setupLinkHandlers();
    }, 100);
  }

  private setupLinkHandlers(): void {
    // Handle privacy policy and terms of service links
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.getAttribute('data-cc-link') === 'privacy') {
        e.preventDefault();
        // Dispatch custom event to open privacy policy
        window.dispatchEvent(new CustomEvent('openPrivacyPolicy'));
      } else if (target.getAttribute('data-cc-link') === 'terms') {
        e.preventDefault();
        // Dispatch custom event to open terms of service
        window.dispatchEvent(new CustomEvent('openTermsOfService'));
      }
    });
  }

  private updateConsentState(): void {
    const userPreferences = CookieConsent.getUserPreferences();
    if (userPreferences && userPreferences.acceptedCategories) {
      this.consentState = {
        necessary: true,
        functional: userPreferences.acceptedCategories.includes('functional'),
        analytics: userPreferences.acceptedCategories.includes('analytics'),
        marketing: userPreferences.acceptedCategories.includes('marketing')
      };
    }
  }

  hasConsent(category: ConsentCategory): boolean {
    return this.consentState[category];
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  showPreferences(): void {
    CookieConsent.showPreferences();
  }

  updateConsent(category: ConsentCategory, value: boolean): void {
    const currentPrefs = CookieConsent.getUserPreferences();
    const acceptedCategories = currentPrefs?.acceptedCategories || ['necessary'];
    
    if (value && !acceptedCategories.includes(category)) {
      acceptedCategories.push(category);
    } else if (!value) {
      const index = acceptedCategories.indexOf(category);
      if (index > -1) {
        acceptedCategories.splice(index, 1);
      }
    }

    CookieConsent.acceptCategory(acceptedCategories);
    this.updateConsentState();
  }

  private loadGoogleAnalytics(): void {
    // Create and append GA script
    if (!document.querySelector('script[src*="googletagmanager.com/gtag"]')) {
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=G-XN4PGT5J9W';
      document.head.appendChild(script);

      script.onload = () => {
        // Initialize gtag
        (window as any).dataLayer = (window as any).dataLayer || [];
        function gtag(...args: any[]) {
          (window as any).dataLayer.push(arguments);
        }
        gtag('js', new Date());
        gtag('config', 'G-XN4PGT5J9W', {
          anonymize_ip: true,
          cookie_flags: 'SameSite=None;Secure'
        });
      };
    }
  }

  private removeGoogleAnalytics(): void {
    // Remove GA cookies
    const cookies = document.cookie.split(';');
    cookies.forEach(cookie => {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
      if (name.startsWith('_ga') || name === '_gid') {
        // Delete cookie for current domain and parent domains
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${window.location.hostname}`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.${window.location.hostname}`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.onestreamer.live`;
      }
    });

    // Remove GA scripts
    const gaScript = document.querySelector('script[src*="googletagmanager.com/gtag"]');
    if (gaScript) {
      gaScript.remove();
    }

    // Clear dataLayer
    (window as any).dataLayer = [];
  }

  reset(): void {
    CookieConsent.reset(true);
    this.consentState = {
      necessary: true,
      functional: false,
      analytics: false,
      marketing: false
    };
  }
}

export default CookieConsentService.getInstance();