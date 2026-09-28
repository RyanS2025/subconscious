// The image window: keep a request to Subconscious at the newest screenshots.
//
// Every coding agent resends its whole history, every screenshot included, on
// every turn, so a long screenshot session's upload grows without end. The
// Subconscious gateway keeps only the newest images before it forwards a
// request, but that does not stop the agent uploading all of them. subc's Pi
// extension (index.ts) and OpenCode plugin apply this rule before the request
// leaves the machine:
//
//   keep the newest screenshots, up to MAX_IMAGES and up to MAX_IMAGE_BYTES
//   in total; replace every older one with the text IMAGE_LABEL.
//
// The label is what keeps Subconscious Cache working. The gateway puts the
// same label before every image, so replacing an image with it removes only
// the image's own tokens and nothing around it moves; the cache then reuses
// the rest of the conversation and each turn only reads the new screenshot.
// MAX_IMAGE_BYTES keeps large screenshots under Baseten's request limit.

export const MAX_IMAGES = 100;
export const IMAGE_LABEL = 'image';
const MIB = 1024 * 1024;
/** Default image budget: under Baseten's 64 MiB request limit, with room for text. */
export const DEFAULT_MAX_IMAGE_MIB = 60;
export const MAX_IMAGE_BYTES =
  positiveNumber(
    process.env.SUBCONSCIOUS_IMAGE_WINDOW_MAX_MIB,
    DEFAULT_MAX_IMAGE_MIB,
  ) * MIB;
const SUBCONSCIOUS_MODEL = /^subconscious\//;
const LABEL_PART = Object.freeze({ type: 'text', text: IMAGE_LABEL });

function positiveNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * How many of the oldest images to drop, given each image's size in order
 * (oldest first). Keeps the newest images while both limits hold, and always
 * keeps the newest one so the model sees the current screen.
 */
export function imagesToDrop(
  sizes,
  maxImages = MAX_IMAGES,
  maxBytes = MAX_IMAGE_BYTES,
) {
  let kept = 0;
  let bytes = 0;
  for (let index = sizes.length - 1; index >= 0; index--) {
    const next = bytes + sizes[index];
    if (kept > 0 && (kept >= maxImages || next > maxBytes)) break;
    kept += 1;
    bytes = next;
  }
  return sizes.length - kept;
}

function contentParts(message) {
  return Array.isArray(message.content) ? message.content : [];
}

function isChatImage(part) {
  return part?.type === 'image_url';
}

function chatImageSize(part) {
  const url =
    typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  return typeof url === 'string' ? url.length : 0;
}

/**
 * Returns a new OpenAI chat payload with the oldest images replaced by the
 * label, or undefined when there is nothing to change.
 */
export function windowImages(
  payload,
  maxImages = MAX_IMAGES,
  maxBytes = MAX_IMAGE_BYTES,
) {
  if (!SUBCONSCIOUS_MODEL.test(payload?.model ?? '')) return undefined;
  if (!Array.isArray(payload.messages)) return undefined;
  const sizes = payload.messages
    .flatMap(contentParts)
    .filter(isChatImage)
    .map(chatImageSize);
  let drop = imagesToDrop(sizes, maxImages, maxBytes);
  if (drop === 0) return undefined;
  const messages = payload.messages.map((message) => {
    if (drop === 0 || !Array.isArray(message.content)) return message;
    const content = message.content.map((part) => {
      if (drop === 0 || !isChatImage(part)) return part;
      drop -= 1;
      return LABEL_PART;
    });
    return { ...message, content };
  });
  return { ...payload, messages };
}

/**
 * Wraps a fetch so every JSON request body goes through windowImages first.
 * Anything else, or a body that is not JSON, is sent unchanged: a problem here
 * must never break a coding session.
 */
export function windowFetch(fetchFn) {
  return async (input, init) => {
    if (typeof init?.body !== 'string') return fetchFn(input, init);
    let windowed;
    try {
      windowed = windowImages(JSON.parse(init.body));
    } catch {
      return fetchFn(input, init);
    }
    if (!windowed) return fetchFn(input, init);
    return fetchFn(input, { ...init, body: JSON.stringify(windowed) });
  };
}
