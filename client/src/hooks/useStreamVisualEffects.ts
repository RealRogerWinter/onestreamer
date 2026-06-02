import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

/**
 * useStreamVisualEffects — renders viewer-side "visual filter" item effects
 * (upside-down, mirror, grayscale, invert, …) by translating the server's
 * `visual-effect-applied` broadcast into CSS the caller merges onto the stream
 * <video> element.
 *
 * These effects re-skin the viewer's own <video>, so they work identically for
 * webcam streams and URL-relay streams — every viewer watches through the same
 * element regardless of how the stream is sourced. (The original server-side
 * VisualFxService that processed the actual media was retired with MediaSoup in
 * ADR-0024; CSS on the viewer element is the LiveKit-era equivalent.)
 *
 * Effects key by effect id: re-applying the same effect refreshes its timer
 * rather than stacking (so two upside-downs don't cancel into a no-op). Distinct
 * effects compose (mirror + flip = 180° rotation, grayscale + dark, …).
 */

/** effect id (item effect_data.visual_effect) → the CSS it contributes. */
const EFFECT_CSS: Record<string, { filter?: string; transform?: string }> = {
  // Color / tone filters
  blur: { filter: 'blur(8px)' },
  grayscale: { filter: 'grayscale(100%)' },
  sepia: { filter: 'sepia(100%)' },
  invert: { filter: 'invert(100%)' },
  brightness_dark: { filter: 'brightness(0.4)' },
  brightness_bright: { filter: 'brightness(1.6)' },
  contrast_low: { filter: 'contrast(0.5)' },
  contrast_high: { filter: 'contrast(2)' },
  saturate: { filter: 'saturate(2.5)' },
  desaturate: { filter: 'saturate(0.3)' },
  hue_rotate: { filter: 'hue-rotate(90deg)' },
  vintage: { filter: 'sepia(0.5) contrast(1.2) brightness(0.9)' },
  thermal: { filter: 'hue-rotate(180deg) saturate(2) contrast(1.5)' },
  vignette: { filter: 'brightness(0.8)' },
  edge_detect: { filter: 'contrast(3) grayscale(100%)' },
  emboss: { filter: 'contrast(1.5) brightness(1.1)' },
  pixelate: { filter: 'contrast(1.5) saturate(1.2)' },
  static_noise: { filter: 'contrast(0.5) saturate(0.2) blur(4px) brightness(0.7) sepia(0.2)' },
  // Orientation / geometry transforms
  mirror: { transform: 'scaleX(-1)' },
  flip_vertical: { transform: 'scaleY(-1)' },
  rotate_90: { transform: 'rotate(90deg)' },
  wave: { transform: 'skew(2deg, 2deg)' },
  wobble: { transform: 'rotate(1deg)' },
};

export interface StreamVisualEffectStyle {
  /** Combined CSS `filter` value, or undefined when no filter effect is active. */
  filter?: string;
  /** Combined CSS `transform` value, or undefined when no transform effect is active. */
  transform?: string;
}

interface ActiveEffect {
  css: { filter?: string; transform?: string };
  timeout: ReturnType<typeof setTimeout>;
}

export function useStreamVisualEffects(socket: Socket | null): StreamVisualEffectStyle {
  const [style, setStyle] = useState<StreamVisualEffectStyle>({});
  const activeRef = useRef<Map<string, ActiveEffect>>(new Map());

  useEffect(() => {
    if (!socket) return;

    const recompute = () => {
      const filters: string[] = [];
      const transforms: string[] = [];
      for (const { css } of activeRef.current.values()) {
        if (css.filter) filters.push(css.filter);
        if (css.transform) transforms.push(css.transform);
      }
      setStyle({
        filter: filters.length ? filters.join(' ') : undefined,
        transform: transforms.length ? transforms.join(' ') : undefined,
      });
    };

    const handleEffect = (data: { effectId?: string; durationSeconds?: number }) => {
      const effectId = data?.effectId;
      if (!effectId) return;
      const css = EFFECT_CSS[effectId];
      // Unknown / non-CSS effects (audio, framerate, freeze, …) carry no visual
      // mapping — ignore them here; they surface only as status-effect icons.
      if (!css) return;

      const durationMs = (Number(data?.durationSeconds) || 20) * 1000;

      const existing = activeRef.current.get(effectId);
      if (existing) clearTimeout(existing.timeout);

      const timeout = setTimeout(() => {
        activeRef.current.delete(effectId);
        recompute();
      }, durationMs);

      activeRef.current.set(effectId, { css, timeout });
      recompute();
    };

    socket.on('visual-effect-applied', handleEffect);

    return () => {
      socket.off('visual-effect-applied', handleEffect);
      for (const { timeout } of activeRef.current.values()) clearTimeout(timeout);
      activeRef.current.clear();
    };
  }, [socket]);

  return style;
}
