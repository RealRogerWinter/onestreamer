/**
 * P2.2 — B2 multipart upload (R6).
 *
 * uploadRecording used a single PutObject, which S3/B2 hard-caps at 5 GB —
 * larger whole-run archives could never upload and retried every 30 min
 * forever. It now uses @aws-sdk/lib-storage's Upload (automatic multipart).
 */

const mockDone = jest.fn();
const mockUploadCtor = jest.fn().mockImplementation(function (config) {
  this.config = config;
  this.done = mockDone;
});

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: mockUploadCtor,
}));

const mockS3ClientConfigs = [];
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: function S3Client(cfg) { mockS3ClientConfigs.push(cfg); },
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  statSync: jest.fn(() => ({ size: 6 * 1024 * 1024 * 1024 })), // 6 GB — over the PutObject cap
  createReadStream: jest.fn(() => 'FAKE_STREAM'),
  readdirSync: jest.fn(() => []),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

describe('B2StorageService.uploadRecording (multipart, R6)', () => {
  let b2Storage;

  beforeAll(() => {
    // Construct the singleton ENABLED: credentials must be present at
    // require time (module exports `new B2StorageService()`).
    process.env.B2_APPLICATION_KEY_ID = 'test-key-id';
    process.env.B2_APPLICATION_KEY = 'test-app-key';
    process.env.B2_BUCKET_ID = 'test-bucket-id';
    process.env.B2_BUCKET_NAME = 'test-bucket';
    process.env.B2_ENDPOINT = 's3.us-west-004.backblazeb2.com';
    jest.isolateModules(() => {
      b2Storage = require('../../services/B2StorageService');
    });
  });

  afterAll(() => {
    delete process.env.B2_APPLICATION_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    delete process.env.B2_BUCKET_ID;
    delete process.env.B2_BUCKET_NAME;
    delete process.env.B2_ENDPOINT;
  });

  beforeEach(() => {
    mockUploadCtor.mockClear();
    mockDone.mockReset();
  });

  test('uses lib-storage Upload with bounded multipart settings', async () => {
    mockDone.mockResolvedValue({ ETag: '"abc123-42"' }); // multipart-style ETag

    const result = await b2Storage.uploadRecording('recording_2026-07-15_1', '/tmp/big.mp4', { foo: 1 });

    expect(result.success).toBe(true);
    expect(result.fileId).toBe('abc123-42');
    expect(result.fileName).toBe('recordings/recording_2026-07-15_1.mp4');

    expect(mockUploadCtor).toHaveBeenCalledTimes(1);
    const cfg = mockUploadCtor.mock.calls[0][0];
    expect(cfg.partSize).toBe(64 * 1024 * 1024);
    expect(cfg.queueSize).toBe(2);
    expect(cfg.leavePartsOnError).toBe(false);
    expect(cfg.params.Bucket).toBe('test-bucket');
    expect(cfg.params.Key).toBe('recordings/recording_2026-07-15_1.mp4');
    expect(cfg.params.ContentType).toBe('video/mp4');
    expect(cfg.params.Body).toBe('FAKE_STREAM');
    expect(cfg.params.Metadata.foo).toBe('1');
    // ContentLength is gone — lib-storage sizes parts itself.
    expect(cfg.params.ContentLength).toBeUndefined();
    expect(mockDone).toHaveBeenCalledTimes(1);
  });

  test('a failed multipart upload returns success:false with the error', async () => {
    mockDone.mockRejectedValue(new Error('B2 exploded'));

    const result = await b2Storage.uploadRecording('recording_2026-07-15_2', '/tmp/big.mp4');

    expect(result).toEqual({ success: false, error: 'B2 exploded' });
  });

  test('S3Client is constructed with bounded network timeouts', () => {
    expect(mockS3ClientConfigs.length).toBeGreaterThan(0);
    expect(mockS3ClientConfigs[0].requestHandler).toEqual({ connectionTimeout: 10_000, requestTimeout: 120_000 });
  });
});
