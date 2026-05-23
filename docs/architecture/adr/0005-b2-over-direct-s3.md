# ADR-0005: Backblaze B2 over direct AWS S3

_Status: accepted_
_Date: 2026-05-23_

## Context

OneStreamer continuously records every live stream into HLS segments and needs to store them somewhere durable. Storage requirements:

- **Volume**: an active stream generates ~5–15 MB/min depending on quality. Multiple streams per day adds up to GBs/week.
- **Access pattern**: write-heavy on stream end; read-rare unless a user is reviewing recordings or watching a clip. Bursts of egress when clips go viral.
- **Latency**: not real-time critical — uploads happen in the background.
- **API**: needs to be an SDK that's already mature in Node.js.

AWS S3 is the default choice for object storage. Backblaze B2 offers an S3-compatible API at significantly lower prices, particularly for egress.

## Decision

**Storage backend is Backblaze B2**, accessed via the AWS SDK (`@aws-sdk/client-s3`) pointed at B2's S3-compatible endpoint.

## Consequences

**Positive.**
- **Lower cost.** B2 storage is ~$0.005/GB/month vs ~$0.023 for S3 standard. Egress is dramatically cheaper (~$0.01/GB vs $0.09/GB at low volume). For an app where viral clips can drive sudden egress spikes, the egress saving alone justifies the choice.
- **S3-compatible API means no SDK lock-in.** If B2 ever stops being attractive, switching to AWS S3, Cloudflare R2, MinIO, etc. requires only an endpoint URL change.
- **Single SDK** for everything object-store-shaped. The code in [`B2StorageService`](../../../server/services/B2StorageService.js) talks plain S3.

**Negative.**
- **B2's S3 compatibility isn't 100%.** A few edge-case S3 features (e.g. certain multipart-upload behaviors, advanced ACLs, S3 Object Lambda) don't work. None affect OneStreamer's use cases today, but a future feature could hit a compatibility wall.
- **No regional AWS data-locality.** OneStreamer's host is in Europe; B2's nearest data center may not be. Acceptable for background uploads; potentially noticeable for `B2_STREAMING_ENABLED=true` playback latency to distant viewers.
- **B2's auth model differs from AWS IAM.** Application keys instead of IAM roles; coarser scoping options. Acceptable for a single-tenant app.
- **B2 is a smaller company than AWS.** Bus factor concern: AWS isn't going anywhere; B2 might pivot or get acquired. The mitigation is the S3-compatible API — switching providers is cheap.

## Alternatives considered

- **AWS S3 directly.** Rejected on cost — both storage and egress are 3–10× more expensive at OneStreamer's volume.
- **Cloudflare R2.** Compelling alternative (zero egress fees), but launched after B2 was already integrated; not worth the migration today.
- **Local-only storage (no cloud).** Initially considered, but local disk for indefinite recording retention isn't viable; uploads protect against host failure.
- **Self-hosted MinIO.** Rejected: adds an additional service to operate and doesn't solve the "what if the host dies" problem unless deployed off-host.

## Operational notes

- The S3-compatible endpoint URL is per-bucket-region (e.g. `s3.us-east-005.backblazeb2.com`). It's set via `B2_ENDPOINT`.
- Credentials are B2 Application Keys (key ID + key secret), not AWS access keys. They look similar to AWS but are issued from B2's dashboard.
- See [`/docs/integrations/backblaze-b2.md`](../../integrations/backblaze-b2.md) for setup and [`/docs/operations/runbooks/recording-upload-failed.md`](../../operations/runbooks/recording-upload-failed.md) for failure-mode recovery.

## References

- [`/docs/integrations/backblaze-b2.md`](../../integrations/backblaze-b2.md)
- [`/docs/features/recording-and-clips.md`](../../features/recording-and-clips.md)
- [Backblaze B2 S3-compatible API docs](https://www.backblaze.com/b2/docs/s3_compatible_api.html)
- [B2 vs S3 cost comparison](https://www.backblaze.com/blog/backblaze-b2-cloud-storage-vs-amazon-s3-cost-comparison/) (Backblaze's own — read with appropriate skepticism, but the underlying pricing is verifiable)
