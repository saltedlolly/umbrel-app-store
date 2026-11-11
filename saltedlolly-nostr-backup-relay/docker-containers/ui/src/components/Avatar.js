import { useState } from "react";
import { colorFor } from "../nostr";

// An ostrich head, used when an account has no picture or it won't load. Its
// colour comes from the account's pubkey, so the same account looks the same
// everywhere on the dashboard.
function Face({ color }) {
  return (
    <svg viewBox="0 0 40 40" className="w-full h-full" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill={color} />
      {/* Neck */}
      <path
        d="M12.6 40c1.4-5.2 3.8-9.4 4.6-14.6.5-3.2-.2-5.4.2-8.2l5.6.3c-.1 3.6.8 6.3.3 10-.6 4.5-2.4 8.4-2.9 12.5z"
        fill="#ffffff"
      />
      {/* Head and beak */}
      <circle cx="19.8" cy="14.2" r="6.6" fill="#ffffff" />
      <path
        d="M24.4 11.6c3 .1 6.3.7 8.7 1.8 1 .5 1 1.6.1 2.2-2.4 1.5-5.6 2.2-9 2.2z"
        fill="#ffffff"
      />
      <path
        d="M25 15.3c2.6 0 5.2-.4 7.6-1.2"
        stroke={color}
        strokeWidth=".8"
        strokeLinecap="round"
        fill="none"
      />
      {/* Eye and lashes */}
      <circle cx="20.8" cy="13.4" r="2.3" fill={color} />
      <circle cx="21.5" cy="12.7" r=".7" fill="#ffffff" />
      <path
        d="M19.4 10.6l-.6-1.4M21 10.4l.1-1.5M22.6 10.8l.7-1.3"
        stroke={color}
        strokeWidth=".7"
        strokeLinecap="round"
      />
      {/* Fluffy head feathers */}
      <path
        d="M15.2 8.9c-.1-1 .3-1.8 1-2.3M17.6 7.8c.2-.9.8-1.5 1.6-1.8M20.4 7.6c.6-.6 1.4-.9 2.2-.8"
        stroke="#ffffff"
        strokeWidth="1.1"
        strokeLinecap="round"
        fill="none"
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
