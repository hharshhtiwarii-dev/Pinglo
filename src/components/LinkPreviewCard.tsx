import React, { memo, useEffect, useState } from 'react';

/**
 * Link preview card (Phase 4, Agent A).
 *
 * Given a URL, tries to fetch the page and parse Open Graph / Twitter Card
 * meta tags (title, description, image) straight from the HTML. No API key,
 * no proxy service — plain `fetch`, so it only works when the target site
 * allows cross-origin reads (most big sites do NOT send CORS headers, and
 * then this falls back gracefully). On ANY failure — network error, CORS
 * block, non-HTML response, no OG tags, timeout — it renders a
 * domain-only fallback card (favicon + hostname + "tap to open"), never an
 * error and never a fake preview. Results are cached in-memory per URL for
 * the session so a chat full of the same link fetches once.
 */

export interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const previewCache = new Map<string, LinkPreview | null>();
const FETCH_TIMEOUT_MS = 6000;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function metaContent(doc: Document, key: string): string | undefined {
  return (
    doc.querySelector(`meta[property="${key}"]`)?.getAttribute('content') ||
    doc.querySelector(`meta[name="${key}"]`)?.getAttribute('content') ||
    undefined
  );
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  if (previewCache.has(url)) return previewCache.get(url) ?? null;
  let result: LinkPreview | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('text/html')) {
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title =
          metaContent(doc, 'og:title') ||
          metaContent(doc, 'twitter:title') ||
          doc.querySelector('title')?.textContent?.trim() ||
          undefined;
        const description =
          metaContent(doc, 'og:description') ||
          metaContent(doc, 'twitter:description') ||
          metaContent(doc, 'description') ||
          undefined;
        let image = metaContent(doc, 'og:image') || metaContent(doc, 'twitter:image') || undefined;
        if (image) {
          try {
            image = new URL(image, url).toString();
          } catch {
            image = undefined;
          }
        }
        const siteName = metaContent(doc, 'og:site_name') || undefined;
        if (title || description || image) result = { title, description, image, siteName };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    result = null;
  }
  previewCache.set(url, result);
  return result;
}

// Typing-freeze fix (Report 3 #20): memoized on the url string — a
// re-rendered bubble no longer re-runs this component's render.
// WA parity (DM audit row 27): `meta` is the bubble's time + ticks,
// rendered at the card's bottom-right like WhatsApp — the caller passes
// it with non-interactive ticks (this card is an <a>, so a <button>
// inside it would be invalid nesting).
function LinkPreviewCardInner({ url, meta }: { url: string; meta?: React.ReactNode }) {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(() =>
    previewCache.has(url) ? previewCache.get(url) ?? null : undefined,
  );
  const [imgFailed, setImgFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setImgFailed(false);
    setFaviconFailed(false);
    if (previewCache.has(url)) {
      setPreview(previewCache.get(url) ?? null);
      return;
    }
    setPreview(undefined);
    fetchPreview(url).then((p) => {
      if (alive) setPreview(p);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const domain = domainOf(url);
  const initial = (domain.charAt(0) || '?').toUpperCase();
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block max-w-xs rounded-lg overflow-hidden mb-1 bg-black/5 dark:bg-white/5 ring-1 ring-black/10 dark:ring-white/10 hover:opacity-90 transition-opacity"
      title={url}
    >
      {preview?.image && !imgFailed && (
        <img
          src={preview.image}
          alt=""
          className="w-full max-h-36 object-cover"
          onError={() => setImgFailed(true)}
        />
      )}
      <div className="px-3 py-2">
        <p className="text-[13px] font-semibold leading-snug break-words line-clamp-2">
          {preview?.title || domain}
        </p>
        {preview?.description && (
          <p className="text-xs opacity-70 leading-snug break-words line-clamp-2 mt-0.5">
            {preview.description}
          </p>
        )}
        <p className="flex items-center gap-1.5 text-[11px] opacity-60 mt-1.5 min-w-0">
          {faviconFailed ? (
            <span className="h-4 w-4 rounded-full bg-green-cta text-white text-[9px] font-bold flex items-center justify-center flex-shrink-0">
              {initial}
            </span>
          ) : (
            <img
              src={faviconUrl}
              alt=""
              className="h-4 w-4 rounded-full flex-shrink-0"
              onError={() => setFaviconFailed(true)}
            />
          )}
          <span className="truncate">{preview?.siteName || domain}</span>
          {!preview && <span className="flex-shrink-0">· tap to open</span>}
          {meta && <span className="flex-shrink-0 ml-auto pl-2">{meta}</span>}
        </p>
      </div>
    </a>
  );
}

const LinkPreviewCard = memo(LinkPreviewCardInner);
export default LinkPreviewCard;
