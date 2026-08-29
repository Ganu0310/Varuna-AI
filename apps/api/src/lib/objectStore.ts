import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../env.js';

/**
 * Object storage, for the one thing the API writes to it: an operator-supplied scene.
 *
 * Everything else in this system reaches object storage from the ML service, which owns
 * raster IO. An upload is the exception — the bytes arrive at the API, and the ML service
 * cannot read the API's local disk when the two run in separate containers. So the API puts
 * the file where the ML service already knows how to look, and passes a bucket and key rather
 * than a path.
 *
 * `forcePathStyle` because MinIO serves buckets as path segments, not subdomains. Without it
 * the SDK resolves `http://varuna.localhost:9000`, which does not exist, and the failure looks
 * like a network error rather than a configuration one.
 */
let client: S3Client | null = null;

export function objectStore(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

/** Where an uploaded scene lives. Content-addressed, so the same bytes are the same key. */
export function uploadKey(checksum: string): string {
  return `uploads/${checksum}.tif`;
}

export async function putScene(key: string, body: Buffer): Promise<void> {
  await objectStore().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: 'image/tiff',
    }),
  );
}

/** True when the object is already there — the upload is idempotent on content. */
export async function sceneExists(key: string): Promise<boolean> {
  try {
    await objectStore().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}
