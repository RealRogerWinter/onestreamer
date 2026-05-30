// Shared types for CanvasEffectOverlay. Extracted verbatim from the parent
// component to keep the public/runtime behavior identical.

export interface EffectData {
  id: string;
  userId: string;
  itemId: string;
  itemName: string;
  displayName: string;
  emoji: string;
  type: string;
  duration: number;
  config: any;
  startTime: number;
  position: { x: number; y: number };
}
