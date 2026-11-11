import { useState } from "react";
import { colorFor } from "../nostr";

// A simple face, used when an account has no picture or it won't load. Its
// colour comes from the account's pubkey, so the same account has the same
// face everywhere on the dashboard.
function Face({ color }) {
  return (
    <svg viewBox="0 0 40 40" className="w-full h-full" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill={color} />
      <circle cx="14" cy="16.5" r="2.6" fill="#ffffff" />
      <circle cx="26" cy="16.5" r="2.6" fill="#ffffff" />
      <path
        d="M12.5 24.5c2 3.4 4.6 5 7.5 5s5.5-1.6 7.5-5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

// An account's profile picture, or its placeholder face. "Others" (accounts
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
