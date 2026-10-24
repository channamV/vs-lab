/**
 * A plain-text reply to a device. It states its exact length (Content-Length) instead of being sent "chunked":
 * Telelogger's HTTP clients only know a reply has ended from its length, and otherwise wait for a timeout
 * (about 5 s per upload over Wi-Fi, seen on the first real device, 2026-10-24).
 */
export function deviceReply(body: string, status = 200): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
