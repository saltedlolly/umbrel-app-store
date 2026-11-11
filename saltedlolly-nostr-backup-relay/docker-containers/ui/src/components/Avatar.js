import { useState } from "react";
import { colorFor } from "../nostr";

// The Nostr logo mark (github.com/mbarulli/nostr-logo, CC0), the same one as
// in the app icon
const NOSTR_MARK =
  "M210.8 199.4c0 3.1-2.5 5.7-5.7 5.7h-68c-3.1 0-5.7-2.5-5.7-5.7v-15.5c.3-19 2.3-37.2 6.5-45.5 2.5-5 6.7-7.7 11.5-9.1 9.1-2.7 24.9-.9 31.7-1.2 0 0 20.4.8 20.4-10.7s-9.1-8.6-9.1-8.6c-10 .3-17.7-.4-22.6-2.4-8.3-3.3-8.6-9.2-8.6-11.2-.4-23.1-34.5-25.9-64.5-20.1-32.8 6.2.4 53.3.4 116.1v8.4c0 3.1-2.6 5.6-5.7 5.6H57.7c-3.1 0-5.7-2.5-5.7-5.7v-144c0-3.1 2.5-5.7 5.7-5.7h31.7c3.1 0 5.7 2.5 5.7 5.7 0 4.7 5.2 7.2 9 4.5 11.4-8.2 26-12.5 42.4-12.5 36.6 0 64.4 21.4 64.4 68.7v83.2ZM150 99.3c0-6.7-5.4-12.1-12.1-12.1s-12.1 5.4-12.1 12.1 5.4 12.1 12.1 12.1S150 106 150 99.3Z";

// Used when an account has no picture or it won't load: the Nostr logo in
// white on the account's colour, so the same account looks the same
// everywhere on the dashboard
function Face({ color }) {
  return (
    <svg viewBox="0 0 256 256" className="w-full h-full" aria-hidden="true">
      <rect width="256" height="256" fill={color} />
      {/* Centred, at about 60% of the circle's width */}
      <path
        transform="translate(30.8 35.8) scale(0.74)"
        d={NOSTR_MARK}
        fill="#ffffff"
      />
    </svg>
  );
}

// An account's profile picture, or its placeholder ostrich. "Others" (accounts
// that aren't synced) gets a plain grey circle.
export default function Avatar({
  pubkey,
  picture,
  label = "",
  other = false,
  size = "w-9 h-9",
  title,
}) {
  const [failedPicture, setFailedPicture] = useState(null);
  const common = `${size} flex-none rounded-full`;
  if (other) {
    return (
      <span
        title={title}
        className={`${common} inline-flex items-center justify-center text-sm font-semibold bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300`}
      >
        <span aria-hidden="true">...</span>
        {title ? <span className="sr-only">{title}</span> : null}
      </span>
    );
  }
  if (picture && failedPicture !== picture) {
    return (
      <img
        src={picture}
        alt={title || label}
        title={title}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailedPicture(picture)}
        className={`${common} object-cover bg-slate-200 dark:bg-slate-700 ring-1 ring-slate-900/5 dark:ring-white/10`}
      />
    );
  }
  return (
    <span
      title={title}
      role="img"
      aria-label={title || label}
      className={`${common} inline-block overflow-hidden`}
    >
      <Face color={colorFor(pubkey || label)} />
    </span>
  );
}
