/**
 * AudioMixer - Mixes multiple audio sources using Web Audio API
 * Used to combine microphone and system audio for screen sharing
 */

// Disable all non-essential logging for production
const DEBUG = false;
const log = DEBUG ? console.log.bind(console) : () => {};

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
    log('🎚️ AUDIO MIXER: Starting mix...', {
      hasMicTrack: !!micTrack,
      hasSystemTrack: !!systemTrack,
      micState: micTrack?.readyState,
      micLabel: micTrack?.label,
      systemState: systemTrack?.readyState,
      systemLabel: systemTrack?.label,
      wasActive: this.isActive,
      hadAudioContext: !!this.audioContext
    });

    // If only one track, return it directly (no mixing needed)
    if (!micTrack && !systemTrack) {
      log('🎚️ AUDIO MIXER: No audio tracks to mix');
      return null;
    }

    if (!micTrack && systemTrack) {
      log('🎚️ AUDIO MIXER: Only system audio, returning directly');
      return systemTrack;
    }

    if (micTrack && !systemTrack) {
      log('🎚️ AUDIO MIXER: Only mic audio, returning directly');
      return micTrack;
    }

    // Both tracks available - mix them
    try {
      // Clean up any previous mix
      this.cleanup();

      log('🎚️ AUDIO MIXER: Input track details:', {
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
        log('🎚️ AUDIO MIXER: AudioContext suspended, resuming...');
        await this.audioContext.resume();
        log('🎚️ AUDIO MIXER: AudioContext resumed, state:', this.audioContext.state);
      }

      // Create destination for mixed output
      this.destination = this.audioContext.createMediaStreamDestination();

      // Set up microphone source with gain control
      if (micTrack) {
        // Clone the mic track to avoid issues with the original
        const clonedMicTrack = micTrack.clone();
        log('🎚️ AUDIO MIXER: Cloned mic track:', {
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

        log('🎚️ AUDIO MIXER: Mic source connected, gain:', this.micGainNode.gain.value);
      }

      // Set up system audio source with gain control
      if (systemTrack) {
        // Clone the system track as well
        const clonedSystemTrack = systemTrack.clone();
        log('🎚️ AUDIO MIXER: Cloned system track:', {
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

        log('🎚️ AUDIO MIXER: System source connected, gain:', this.systemGainNode.gain.value);
      }

      // Get the mixed audio track
      this.mixedStream = this.destination.stream;
      const mixedTrack = this.mixedStream.getAudioTracks()[0];

      if (!mixedTrack) {
        throw new Error('Failed to create mixed audio track');
      }

      this.isActive = true;
      log('🎚️ AUDIO MIXER: ✅ Mix created successfully', {
        mixedTrackId: mixedTrack.id,
        mixedTrackState: mixedTrack.readyState,
        mixedTrackEnabled: mixedTrack.enabled,
        mixedTrackMuted: mixedTrack.muted,
        audioContextState: this.audioContext.state,
        hasMicSource: !!this.micSource,
        hasSystemSource: !!this.systemSource,
        micGain: this.micGainNode?.gain.value,
        systemGain: this.systemGainNode?.gain.value
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
      log('🎚️ AUDIO MIXER: Mic gain set to', this.micGainNode.gain.value);
    }
  }

  /**
   * Update system audio gain in real-time
   */
  setSystemGain(gain: number): void {
    if (this.systemGainNode) {
      this.systemGainNode.gain.value = Math.max(0, Math.min(1, gain));
      log('🎚️ AUDIO MIXER: System gain set to', this.systemGainNode.gain.value);
    }
  }

  /**
   * Update the microphone track in real-time (e.g., when mic is switched)
   * This swaps the mic source without disrupting the mixed output
   * @param newMicTrack - New audio track from microphone
   */
  async updateMicTrack(newMicTrack: MediaStreamTrack | null): Promise<void> {
    log('🎚️ AUDIO MIXER: updateMicTrack called', {
      isActive: this.isActive,
      hasAudioContext: !!this.audioContext,
      audioContextState: this.audioContext?.state,
      hasDestination: !!this.destination,
      hasSystemSource: !!this.systemSource,
      hasSystemGainNode: !!this.systemGainNode,
      hasMicSource: !!this.micSource,
      hasMicGainNode: !!this.micGainNode
    });

    if (!this.isActive || !this.audioContext || !this.destination) {
      log('🎚️ AUDIO MIXER: Not active, skipping mic update');
      return;
    }

    log('🎚️ AUDIO MIXER: Updating mic track...', {
      hasNewTrack: !!newMicTrack,
      newTrackState: newMicTrack?.readyState,
      newTrackLabel: newMicTrack?.label
    });

    try {
      // Disconnect old mic source (but keep gain node connected to destination)
      if (this.micSource) {
        log('🎚️ AUDIO MIXER: Disconnecting old mic source...');
        this.micSource.disconnect();
        this.micSource = null;
      }

      // If no new track, just continue without mic (system audio only)
      if (!newMicTrack || newMicTrack.readyState !== 'live') {
        log('🎚️ AUDIO MIXER: No valid mic track, continuing with system audio only');
        return;
      }

      // Resume audio context if needed
      if (this.audioContext.state === 'suspended') {
        log('🎚️ AUDIO MIXER: Resuming suspended AudioContext...');
        await this.audioContext.resume();
      }

      // Create new mic source from the new track
      const clonedMicTrack = newMicTrack.clone();
      const micStream = new MediaStream([clonedMicTrack]);
      this.micSource = this.audioContext.createMediaStreamSource(micStream);

      // If we don't have a gain node yet, create one
      if (!this.micGainNode) {
        log('🎚️ AUDIO MIXER: Creating new mic gain node...');
        this.micGainNode = this.audioContext.createGain();
        this.micGainNode.gain.value = 1.0;
        this.micGainNode.connect(this.destination);
      }

      // Connect new source to existing gain node
      this.micSource.connect(this.micGainNode);

      log('🎚️ AUDIO MIXER: ✅ Mic track updated successfully', {
        newTrackId: clonedMicTrack.id,
        micGain: this.micGainNode.gain.value,
        systemSourceStillConnected: !!this.systemSource,
        systemGain: this.systemGainNode?.gain.value,
        audioContextState: this.audioContext.state
      });

    } catch (error) {
      console.error('🎚️ AUDIO MIXER: ❌ Failed to update mic track:', error);
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
    log('🎚️ AUDIO MIXER: Cleaning up...');

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
      log('🎚️ AUDIO MIXER: Cleanup complete');

    } catch (error) {
      console.error('🎚️ AUDIO MIXER: Error during cleanup:', error);
    }
  }
}

// Export singleton instance
export const audioMixer = new AudioMixer();

export default AudioMixer;
