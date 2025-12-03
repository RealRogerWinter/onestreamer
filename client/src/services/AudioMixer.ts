/**
 * AudioMixer - Mixes multiple audio sources using Web Audio API
 * Used to combine microphone and system audio for screen sharing
 */

export interface AudioMixerOptions {
  micGain?: number;      // 0-1, default 1.0
  systemGain?: number;   // 0-1, default 1.0
}

export class AudioMixer {
  private audioContext: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private micGainNode: GainNode | null = null;
  private systemGainNode: GainNode | null = null;
  private mixedStream: MediaStream | null = null;
  private isActive: boolean = false;

  /**
   * Check if Web Audio API is supported
   */
  static isSupported(): boolean {
    return typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined';
  }

  /**
   * Mix microphone and system audio into a single audio track
   * @param micTrack - MediaStreamTrack from microphone
   * @param systemTrack - MediaStreamTrack from screen share system audio
   * @param options - Gain options for each source
   * @returns MediaStreamTrack with mixed audio
   */
  async mix(
    micTrack: MediaStreamTrack | null,
    systemTrack: MediaStreamTrack | null,
    options: AudioMixerOptions = {}
  ): Promise<MediaStreamTrack | null> {
    console.log('🎚️ AUDIO MIXER: Starting mix...', {
      hasMicTrack: !!micTrack,
      hasSystemTrack: !!systemTrack,
      micState: micTrack?.readyState,
      systemState: systemTrack?.readyState
    });

    // If only one track, return it directly (no mixing needed)
    if (!micTrack && !systemTrack) {
      console.warn('🎚️ AUDIO MIXER: No audio tracks to mix');
      return null;
    }

    if (!micTrack && systemTrack) {
      console.log('🎚️ AUDIO MIXER: Only system audio, returning directly');
      return systemTrack;
    }

    if (micTrack && !systemTrack) {
      console.log('🎚️ AUDIO MIXER: Only mic audio, returning directly');
      return micTrack;
    }

    // Both tracks available - mix them
    try {
      // Clean up any previous mix
      this.cleanup();

      console.log('🎚️ AUDIO MIXER: Input track details:', {
        micTrackId: micTrack?.id,
        micTrackLabel: micTrack?.label,
        micTrackEnabled: micTrack?.enabled,
        micTrackMuted: micTrack?.muted,
        micTrackState: micTrack?.readyState,
        systemTrackId: systemTrack?.id,
        systemTrackLabel: systemTrack?.label,
        systemTrackEnabled: systemTrack?.enabled,
        systemTrackMuted: systemTrack?.muted,
        systemTrackState: systemTrack?.readyState
      });

      // Create audio context
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass();

      // Resume audio context if suspended (Chrome autoplay policy)
      if (this.audioContext.state === 'suspended') {
        console.log('🎚️ AUDIO MIXER: AudioContext suspended, resuming...');
        await this.audioContext.resume();
        console.log('🎚️ AUDIO MIXER: AudioContext resumed, state:', this.audioContext.state);
      }

      // Create destination for mixed output
      this.destination = this.audioContext.createMediaStreamDestination();

      // Set up microphone source with gain control
      if (micTrack) {
        // Clone the mic track to avoid issues with the original
        const clonedMicTrack = micTrack.clone();
        console.log('🎚️ AUDIO MIXER: Cloned mic track:', {
          originalId: micTrack.id,
          clonedId: clonedMicTrack.id,
          clonedEnabled: clonedMicTrack.enabled,
          clonedState: clonedMicTrack.readyState
        });

        const micStream = new MediaStream([clonedMicTrack]);
        this.micSource = this.audioContext.createMediaStreamSource(micStream);
        this.micGainNode = this.audioContext.createGain();
        this.micGainNode.gain.value = options.micGain ?? 1.0;

        this.micSource.connect(this.micGainNode);
        this.micGainNode.connect(this.destination);

        console.log('🎚️ AUDIO MIXER: Mic source connected, gain:', this.micGainNode.gain.value);
      }

      // Set up system audio source with gain control
      if (systemTrack) {
        // Clone the system track as well
        const clonedSystemTrack = systemTrack.clone();
        console.log('🎚️ AUDIO MIXER: Cloned system track:', {
          originalId: systemTrack.id,
          clonedId: clonedSystemTrack.id,
          clonedEnabled: clonedSystemTrack.enabled,
          clonedState: clonedSystemTrack.readyState
        });

        const systemStream = new MediaStream([clonedSystemTrack]);
        this.systemSource = this.audioContext.createMediaStreamSource(systemStream);
        this.systemGainNode = this.audioContext.createGain();
        this.systemGainNode.gain.value = options.systemGain ?? 1.0;

        this.systemSource.connect(this.systemGainNode);
        this.systemGainNode.connect(this.destination);

        console.log('🎚️ AUDIO MIXER: System source connected, gain:', this.systemGainNode.gain.value);
      }

      // Get the mixed audio track
      this.mixedStream = this.destination.stream;
      const mixedTrack = this.mixedStream.getAudioTracks()[0];

      if (!mixedTrack) {
        throw new Error('Failed to create mixed audio track');
      }

      this.isActive = true;
      console.log('🎚️ AUDIO MIXER: ✅ Mix created successfully', {
        mixedTrackId: mixedTrack.id,
        mixedTrackState: mixedTrack.readyState,
        mixedTrackEnabled: mixedTrack.enabled,
        audioContextState: this.audioContext.state
      });

      return mixedTrack;

    } catch (error) {
      console.error('🎚️ AUDIO MIXER: ❌ Failed to mix audio:', error);
      this.cleanup();
      return null;
    }
  }

  /**
   * Update mic gain in real-time
   */
  setMicGain(gain: number): void {
    if (this.micGainNode) {
      this.micGainNode.gain.value = Math.max(0, Math.min(1, gain));
      console.log('🎚️ AUDIO MIXER: Mic gain set to', this.micGainNode.gain.value);
    }
  }

  /**
   * Update system audio gain in real-time
   */
  setSystemGain(gain: number): void {
    if (this.systemGainNode) {
      this.systemGainNode.gain.value = Math.max(0, Math.min(1, gain));
      console.log('🎚️ AUDIO MIXER: System gain set to', this.systemGainNode.gain.value);
    }
  }

  /**
   * Get current mixed stream
   */
  getMixedStream(): MediaStream | null {
    return this.mixedStream;
  }

  /**
   * Check if mixer is currently active
   */
  getIsActive(): boolean {
    return this.isActive;
  }

  /**
   * Clean up all audio resources
   */
  cleanup(): void {
    console.log('🎚️ AUDIO MIXER: Cleaning up...');

    try {
      // Disconnect sources
      if (this.micSource) {
        this.micSource.disconnect();
        this.micSource = null;
      }

      if (this.systemSource) {
        this.systemSource.disconnect();
        this.systemSource = null;
      }

      // Disconnect gain nodes
      if (this.micGainNode) {
        this.micGainNode.disconnect();
        this.micGainNode = null;
      }

      if (this.systemGainNode) {
        this.systemGainNode.disconnect();
        this.systemGainNode = null;
      }

      // Clear destination
      this.destination = null;
      this.mixedStream = null;

      // Close audio context
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close();
        this.audioContext = null;
      }

      this.isActive = false;
      console.log('🎚️ AUDIO MIXER: Cleanup complete');

    } catch (error) {
      console.error('🎚️ AUDIO MIXER: Error during cleanup:', error);
    }
  }
}

// Export singleton instance
export const audioMixer = new AudioMixer();

export default AudioMixer;
