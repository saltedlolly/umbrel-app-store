import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { RELAY_PROXY_URL } from "../constants/constants";

// Web links and nostr: links (NIP-21) in a post
const LINK =
  /(https?:\/\/[^\s<>"'`]+)|(nostr:(?:npub|note|nevent|nprofile|naddr)1[02-9ac-hj-np-z]+)/gi;
const IMAGE = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;
// Previews and images shown per post
const MAX_PREVIEWS = 2;

// Trailing punctuation usually ends the sentence, not the link
function trimLink(link) {
  let value = link;
  while (/[.,;:!?)\]}'"]$/.test(value)) {
    if (
      value.endsWith(")") &&
      value.split("(").length > value.split(")").length - 1
    )
      break;
    value = value.slice(0, -1);
  }
  return value;
}

export function splitContent(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const link = trimLink(match[0]);
    if (match.index > last)
      parts.push({ type: "text", value: text.slice(last, match.index) });
    if (match[2] || link.toLowerCase().startsWith("nostr:")) {
      parts.push({ type: "nostr", value: link });
    } else {
      parts.push({ type: IMAGE.test(link) ? "image" : "link", value: link });
    }
    last = match.index + link.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

// Share cards, fetched once per link for the whole page
const previews = new Map();
function loadPreview(url) {
  if (!previews.has(url)) {
    previews.set(
      url,
      axios
        .get(`${RELAY_PROXY_URL}/preview`, { params: { url } })
        .then(({ data }) => data?.preview || null)
        .catch(() => null),
    );
  }
  return previews.get(url);
}

// True once the element has scrolled near the screen, so long lists only
// fetch previews for the posts someone actually looks at
function useNearScreen() {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !ref.current) return;
    if (!("IntersectionObserver" in window)) return setNear(true);
    const observer = new IntersectionObserver(
      (entries) =>
        entries.some((entry) => entry.isIntersecting) && setNear(true),
      { rootMargin: "200px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

function usePreviews(urls, enabled) {
  const [loaded, setLoaded] = useState({});
  const key = urls.join(" ");
  useEffect(() => {
    if (!enabled || !key) return;
    let stopped = false;
    for (const url of key.split(" ")) {
      loadPreview(url).then((preview) => {
        if (!stopped)
          setLoaded((previous) => ({ ...previous, [url]: preview }));
      });
    }
    return () => {
      stopped = true;
    };
  }, [key, enabled]);
  return loaded;
}

function ShareCard({ preview, small }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="block mt-2 overflow-hidden rounded-md bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/10 hover:ring-violet-400 dark:hover:ring-violet-400/60"
    >
      {preview.image && !imageFailed ? (
        <img
          src={preview.image}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setImageFailed(true)}
          className={`w-full ${
            small ? "max-h-28" : "max-h-44"
          } object-cover bg-slate-100 dark:bg-slate-700`}
        />
      ) : null}
      <span className="block px-2.5 py-2">
        <span className="block text-[0.7rem] uppercase tracking-wide text-slate-400 dark:text-slate-500 truncate">
          {preview.siteName}
        </span>
        {preview.title ? (
          <span className="block text-sm font-medium text-slate-800 dark:text-slate-100 leading-snug">
            {preview.title}
          </span>
        ) : null}
        {preview.description && !small ? (
          <span
            className="block mt-0.5 text-xs text-slate-500 dark:text-slate-400 overflow-hidden"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {preview.description}
          </span>
        ) : null}
      </span>
    </a>
  );
}

function PostImage({ src, onFail }) {
  return (
    <a href={src} target="_blank" rel="noopener noreferrer nofollow">
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={onFail}
        className="mt-2 max-h-72 w-auto max-w-full rounded-md object-contain bg-slate-100 dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/10"
      />
    </a>
  );
}

function shortLink(url) {
  const text = url.replace(/^https?:\/\/(www\.)?/i, "");
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

const linkClass =
  "text-violet-600 dark:text-violet-300 underline underline-offset-2 decoration-violet-300 dark:decoration-violet-500/60 hover:decoration-2 break-all";

// A post's text with clickable links. Image links show the image, and the
// first web links show their share card instead of the address, once loaded.
export default function PostContent({ text, small = false }) {
  const parts = splitContent(text);
  const [ref, near] = useNearScreen();
  const [failedImages, setFailedImages] = useState({});
  const images = parts
    .filter((part) => part.type === "image" && !failedImages[part.value])
    .map((part) => part.value)
    .slice(0, MAX_PREVIEWS);
  const links = [
    ...new Set(
      parts.filter((part) => part.type === "link").map((part) => part.value),
    ),
  ].slice(0, MAX_PREVIEWS);
  const loaded = usePreviews(links, near);
  const cards = links.filter((url) => loaded[url]);

  // Links shown as a share card or an image below the text are left out of
  // it, along with the blank lines they leave behind
  const visibleParts = [];
  for (const part of parts) {
    if (part.type === "link" && loaded[part.value]) continue;
    if (part.type === "image" && images.includes(part.value)) continue;
    const last = visibleParts[visibleParts.length - 1];
    if (part.type === "text" && last?.type === "text") last.value += part.value;
    else visibleParts.push({ ...part });
  }
  visibleParts.forEach((part, index) => {
    if (part.type !== "text") return;
    part.value = part.value.replace(/[ \t]*\n[ \t\n]*\n[ \t]*/g, "\n\n");
    if (index === 0) part.value = part.value.replace(/^\s+/, "");
    if (index === visibleParts.length - 1)
      part.value = part.value.replace(/\s+$/, "");
  });

  return (
    <div ref={ref} className="min-w-0">
      <p
        className={`text-slate-700 dark:text-slate-300 ${
          small ? "text-xs" : "text-sm"
        } whitespace-pre-line break-words`}
      >
        {visibleParts.map((part, index) => {
          if (part.type === "text") return part.value;
          const href =
            part.type === "nostr"
              ? `https://njump.me/${part.value.slice(6)}`
              : part.value;
          const label =
            part.type === "nostr"
              ? `${part.value.slice(6, 16)}...${part.value.slice(-5)}`
              : shortLink(part.value);
          return (
            <a
              key={index}
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={linkClass}
              title={part.value}
            >
              {label}
            </a>
          );
        })}
      </p>
      {images.map((src) => (
        <PostImage
          key={src}
          src={src}
          onFail={() =>
            setFailedImages((previous) => ({ ...previous, [src]: true }))
          }
        />
      ))}
      {cards.map((url) => (
        <ShareCard key={url} preview={loaded[url]} small={small} />
      ))}
    </div>
  );
}
