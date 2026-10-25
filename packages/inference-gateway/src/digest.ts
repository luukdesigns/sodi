/**
 * The delivery receipt: a sha256 of exactly the bytes the client received.
 *
 *   non-streamed   `Sodi-Delivery-Digest: sha256=<hex>` header over the response body
 *   streamed       headers leave before the body exists, so the digest of every byte streamed comes
 *                  last, as an SSE comment line: `: sodi-delivery-digest sha256=<hex>`. SSE clients
 *                  ignore comment lines, so OpenAI and Anthropic SDKs are unaffected.
 *
 * Streams are hashed over their raw bytes rather than the concatenated text deltas, so the receipt
 * also covers tool calls, stop reasons and usage.
 */
import { createHash } from 'node:crypto';

export const DIGEST_HEADER = 'Sodi-Delivery-Digest';
export const STREAM_DIGEST_PREFIX = ': sodi-delivery-digest ';

export const deliveryDigest = (bytes: Uint8Array | string): string => `sha256=${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Passes a stream through, hashing it, and appends the digest line at the end. An upstream that
 * breaks off mid-stream ends the stream cleanly with a comment saying so (and the digest of what was
 * sent) rather than an error, so nothing about the request ends up in an error log.
 */
export function digestingStream(
  source: ReadableStream<Uint8Array>,
  /** Called with everything streamed, once it ends; may return SSE comment lines to add before the digest. */
  onEnd?: (streamed: string) => string | undefined,
): ReadableStream<Uint8Array> {
  const hash = createHash('sha256');
  const seen: Uint8Array[] = [];
  const reader = source.getReader();
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        const note = enc.encode(': sodi-delivery-error the upstream stream ended early\n\n');
        hash.update(note);
        controller.enqueue(note);
        chunk = { done: true, value: undefined };
      }
      if (chunk.done) {
        const extra = onEnd?.(Buffer.concat(seen).toString('utf8'));
        if (extra) {
          const bytes = enc.encode(extra);
          hash.update(bytes);
          controller.enqueue(bytes);
        }
        controller.enqueue(enc.encode(`${STREAM_DIGEST_PREFIX}sha256=${hash.digest('hex')}\n\n`));
        controller.close();
        return;
      }
      hash.update(chunk.value);
      if (onEnd) seen.push(chunk.value);
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Client side: checks a received body against its digest. Returns the digest if it matches. */
export function checkDelivery(body: string, headerDigest?: string | null): { ok: boolean; digest?: string } {
  if (headerDigest) return { ok: deliveryDigest(body) === headerDigest, digest: headerDigest };
  const at = body.lastIndexOf(STREAM_DIGEST_PREFIX);
  if (at < 0) return { ok: false };
  const digest = body.slice(at + STREAM_DIGEST_PREFIX.length).trim();
  return { ok: deliveryDigest(body.slice(0, at)) === digest, digest };
}
