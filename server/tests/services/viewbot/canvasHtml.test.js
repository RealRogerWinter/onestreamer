const { buildCanvasHTML } = require('../../../services/viewbot/canvasHtml');

describe('buildCanvasHTML', () => {
  const baseConfig = {
    width: 1280, height: 720, contentType: 'testPattern', testPattern: 'clock',
    backgroundColor: '#abcdef', customText: 'Hello', textColor: '#00ff88', fontSize: 50, frameRate: 30,
  };

  test('interpolates dimensions, botId, content type, and resolution line', () => {
    const html = buildCanvasHTML(baseConfig, 'bot-XYZ');
    expect(html).toContain('width="1280" height="720"');
    expect(html).toContain('bot-XYZ');
    expect(html).toContain("'testPattern'");
    expect(html).toContain("'clock'");
    expect(html).toContain('Resolution: 1280×720 | FPS: 30');
    expect(html).toContain('#abcdef');
    expect(html).toContain('Hello');
  });

  test('applies defaults when optional config fields are absent', () => {
    const html = buildCanvasHTML({ width: 640, height: 360, contentType: 'testPattern', frameRate: 24 }, 'b1');
    expect(html).toContain("'color-bars'"); // testPattern default
    expect(html).toContain('#001122');       // backgroundColor default
    expect(html).toContain('Custom Text');   // customText default
    expect(html).toContain('#00ff88');       // textColor default
    expect(html).toContain('Resolution: 640×360 | FPS: 24');
  });
});
