import { parseColor } from './color';

describe('effectEngine/color parseColor', () => {
  it('parses rgb() into an {r,g,b} triple', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
  });

  it('parses rgba() ignoring the alpha channel', () => {
    expect(parseColor('rgba(255, 128, 64, 0.5)')).toEqual({ r: 255, g: 128, b: 64 });
  });

  it('parses 6-digit hex (case-insensitive)', () => {
    expect(parseColor('#ff8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseColor('#00FF00')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('falls back to gray smoke for unrecognized input', () => {
    expect(parseColor('not-a-color')).toEqual({ r: 120, g: 120, b: 120 });
    expect(parseColor('#abc')).toEqual({ r: 120, g: 120, b: 120 });
  });
});
