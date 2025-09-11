/**
 * PermissionService - Manages camera and microphone permissions for streaming
 * Ensures users have granted necessary permissions before going live
 */

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'checking' | 'error';

export interface MediaPermissions {
  camera: PermissionState;
  microphone: PermissionState;
  lastChecked: number;
  errorMessage?: string;
}

export interface PermissionCheckResult {
  success: boolean;
  permissions: MediaPermissions;
  stream?: MediaStream;
  error?: string;
}

class PermissionService {
  private static instance: PermissionService;
  private cachedPermissions: MediaPermissions | null = null;
  private permissionCheckTimeout = 10000; // 10 seconds timeout
  private cacheValidityMs = 30000; // Cache valid for 30 seconds

  private constructor() {}

  public static getInstance(): PermissionService {
    if (!PermissionService.instance) {
      PermissionService.instance = new PermissionService();
    }
    return PermissionService.instance;
  }

  /**
   * Check if browser supports necessary APIs
   */
  public isSupported(): boolean {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Get current permission status using Permissions API if available
   */
  private async queryPermissionStatus(name: 'camera' | 'microphone'): Promise<PermissionState> {
    try {
      // Check if Permissions API is available
      if ('permissions' in navigator && 'query' in navigator.permissions) {
        const result = await navigator.permissions.query({ name: name as PermissionName });
        return result.state as PermissionState;
      }
    } catch (error) {
      // Permissions API not available or failed
      console.log(`Permissions API not available for ${name}, will check via getUserMedia`);
    }
    return 'prompt';
  }

  /**
   * Check current permission status without triggering a prompt
   */
  public async checkPermissions(useCache: boolean = true): Promise<MediaPermissions> {
    // Return cached permissions if still valid
    if (useCache && this.cachedPermissions) {
      const cacheAge = Date.now() - this.cachedPermissions.lastChecked;
      if (cacheAge < this.cacheValidityMs) {
        return this.cachedPermissions;
      }
    }

    const permissions: MediaPermissions = {
      camera: 'checking',
      microphone: 'checking',
      lastChecked: Date.now()
    };

    try {
      // First try using Permissions API
      const [cameraStatus, micStatus] = await Promise.all([
        this.queryPermissionStatus('camera'),
        this.queryPermissionStatus('microphone')
      ]);

      permissions.camera = cameraStatus;
      permissions.microphone = micStatus;

      // If both are already granted, we're good
      if (cameraStatus === 'granted' && micStatus === 'granted') {
        this.cachedPermissions = permissions;
        return permissions;
      }

      // If either is prompt or denied, we need to handle accordingly
      // Don't trigger getUserMedia here as it would show a prompt
      
    } catch (error) {
      console.warn('Error checking permissions:', error);
      permissions.errorMessage = 'Could not determine permission status';
    }

    this.cachedPermissions = permissions;
    return permissions;
  }

  /**
   * Request permissions and get a media stream
   * This WILL show a permission prompt if needed
   */
  public async requestPermissions(
    video: boolean = true,
    audio: boolean = true,
    videoConstraints?: MediaTrackConstraints,
    audioConstraints?: MediaTrackConstraints
  ): Promise<PermissionCheckResult> {
    if (!this.isSupported()) {
      return {
        success: false,
        permissions: {
          camera: 'error',
          microphone: 'error',
          lastChecked: Date.now(),
          errorMessage: 'Browser does not support media devices. Please use a modern browser.'
        },
        error: 'Browser does not support media devices'
      };
    }

    const permissions: MediaPermissions = {
      camera: 'checking',
      microphone: 'checking',
      lastChecked: Date.now()
    };

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Permission request timeout')), this.permissionCheckTimeout);
      });

      // Request media with timeout
      const constraints: MediaStreamConstraints = {};
      
      if (video) {
        constraints.video = videoConstraints || {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        };
      }
      
      if (audio) {
        constraints.audio = audioConstraints || {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: { ideal: 48000 }
        };
      }

      // Race between getUserMedia and timeout
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia(constraints),
        timeoutPromise
      ]) as MediaStream;

      // Successfully got stream - permissions are granted
      permissions.camera = video ? 'granted' : 'prompt';
      permissions.microphone = audio ? 'granted' : 'prompt';
      
      this.cachedPermissions = permissions;

      return {
        success: true,
        permissions,
        stream
      };

    } catch (error: any) {
      // Handle different error types
      let errorMessage = 'Unknown error occurred';
      
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        // User denied permissions
        permissions.camera = video ? 'denied' : 'prompt';
        permissions.microphone = audio ? 'denied' : 'prompt';
        errorMessage = 'Camera and microphone permissions were denied. Please allow access to go live.';
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        // No devices found
        permissions.camera = 'error';
        permissions.microphone = 'error';
        errorMessage = 'No camera or microphone found. Please connect a webcam and microphone.';
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        // Device in use
        permissions.camera = 'error';
        permissions.microphone = 'error';
        errorMessage = 'Camera or microphone is already in use by another application.';
      } else if (error.name === 'OverconstrainedError') {
        // Constraints cannot be satisfied
        errorMessage = 'The requested video/audio settings are not supported by your device.';
      } else if (error.message === 'Permission request timeout') {
        // Timeout
        errorMessage = 'Permission request timed out. Please try again.';
      } else if (error.name === 'TypeError' || error.name === 'SecurityError') {
        // Security error - usually means not HTTPS
        errorMessage = 'Streaming requires a secure connection (HTTPS). Please access the site via HTTPS.';
      }

      permissions.errorMessage = errorMessage;
      this.cachedPermissions = permissions;

      return {
        success: false,
        permissions,
        error: errorMessage
      };
    }
  }

  /**
   * Release a media stream and stop all tracks
   */
  public releaseStream(stream: MediaStream | null): void {
    if (!stream) return;
    
    stream.getTracks().forEach(track => {
      track.stop();
    });
  }

  /**
   * Clear cached permissions
   */
  public clearCache(): void {
    this.cachedPermissions = null;
  }

  /**
   * Check if permissions are sufficient for streaming
   */
  public canStream(permissions: MediaPermissions): boolean {
    return permissions.camera === 'granted' && permissions.microphone === 'granted';
  }

  /**
   * Get user-friendly message for permission state
   */
  public getPermissionMessage(permissions: MediaPermissions): string {
    if (permissions.errorMessage) {
      return permissions.errorMessage;
    }

    if (this.canStream(permissions)) {
      return 'Camera and microphone are ready!';
    }

    if (permissions.camera === 'denied' || permissions.microphone === 'denied') {
      return 'Camera and microphone access is required to stream. Please grant permissions and refresh the page.';
    }

    if (permissions.camera === 'prompt' || permissions.microphone === 'prompt') {
      return 'Click to grant camera and microphone permissions';
    }

    if (permissions.camera === 'checking' || permissions.microphone === 'checking') {
      return 'Checking permissions...';
    }

    return 'Unable to access camera and microphone';
  }

  /**
   * Get browser-specific instructions for enabling permissions
   */
  public getPermissionInstructions(): string {
    const userAgent = navigator.userAgent.toLowerCase();
    
    if (userAgent.includes('chrome')) {
      return `To enable permissions in Chrome:
1. Click the camera icon in the address bar
2. Select "Allow" for camera and microphone
3. Refresh the page`;
    } else if (userAgent.includes('firefox')) {
      return `To enable permissions in Firefox:
1. Click the lock icon in the address bar
2. Click the blocked camera/microphone
3. Select "Allow" and refresh the page`;
    } else if (userAgent.includes('safari')) {
      return `To enable permissions in Safari:
1. Go to Safari > Settings > Websites
2. Select Camera and Microphone
3. Allow access for this website`;
    } else if (userAgent.includes('edge')) {
      return `To enable permissions in Edge:
1. Click the lock icon in the address bar
2. Select "Permissions for this site"
3. Allow camera and microphone access`;
    }
    
    return `To enable permissions:
1. Look for a camera/lock icon in your address bar
2. Allow camera and microphone access
3. Refresh the page`;
  }
}

export default PermissionService.getInstance();