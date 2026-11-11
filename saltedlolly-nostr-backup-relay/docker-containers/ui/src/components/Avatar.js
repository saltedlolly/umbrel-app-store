import { useState } from "react";
import { colorFor } from "../nostr";

const FEATHERS = "#efe6d8";
const LINE = "#3f3a36";

// One eye: amber iris, slit pupil and a heavy lid with lashes (drawn for the
// left eye; the right eye is the same, mirrored)
function Eye({ mirrored }) {
  return (
    <g transform={mirrored ? "matrix(-1 0 0 1 40 0)" : undefined}>
      <circle cx="12.4" cy="16.4" r="3.6" fill="#7a5c6e" />
      <circle cx="12.6" cy="16.7" r="3" fill="#b45309" />
      <ellipse cx="12.7" cy="16.9" rx="1" ry="1.5" fill="#1c1917" />
      <circle cx="11.7" cy="17.6" r=".55" fill="#ffffff" />
      <path
        d="M8.6 16.6c.1-3 2-4.6 3.9-4.6s3.8 1.6 3.9 4.6c-1.3-.7-2.6-1-3.9-1s-2.6.3-3.9 1z"
        fill="#d9c9b6"
      />
      <path
        d="M8.7 16.5c1.2-.6 2.5-.9 3.8-.9s2.6.3 3.8.9"
        stroke={LINE}
        strokeWidth=".55"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M8.8 16.3l-1-.6M9.7 15.8l-.6-1M10.9 15.5l-.3-1.1"
        stroke={LINE}
        strokeWidth=".4"
        strokeLinecap="round"
      />
    </g>
  );
}

// A grumpy ostrich, face on, used when an account has no picture or it won't
// load. The background is the account's colour, so the same account looks the
// same everywhere on the dashboard.
function Face({ color }) {
  return (
    <svg viewBox="0 0 40 40" className="w-full h-full" aria-hidden="true">
      <rect width="40" height="40" fill={color} />
      {/* Neck */}
      <path
        d="M16 41c.3-4.6.9-8 1.3-11.5h5.4c.4 3.5 1 6.9 1.3 11.5z"
        fill={FEATHERS}
      />
      {/* Fluffy head and the wild tuft on top */}
      <path
        d="M7.4 18.6c-.3-3.1.9-6.2 3.2-8.1.3-1.2 1.3-2 2.5-2.1.9-1.1 2.3-1.6 3.6-1.3 1.1-.8 2.6-1 3.9-.5 1.3-.5 2.8-.3 3.9.6 1.3.1 2.5.8 3.1 2 2.4 1.9 3.6 5 3.3 8.1-.2 1.4.2 2.4-.3 3.8-1.3 4.6-6.1 7.9-12.6 7.9s-11.3-3.3-12.6-7.9c-.5-1.4-.1-2.4 0-3.5z"
        fill={FEATHERS}
      />
      <path
        d="M11.6 9.6l-1.4-2.3M14.8 7.6l-.9-2.6M18.2 6.6l-.2-2.9M21.8 6.6l.6-2.8M25 7.5l1.4-2.4M28.2 9.4l2-1.8M23 6.8c1.4-2.4 3.4-3.6 5.6-3.9M24 6.9c1.8-1.6 3.9-2.2 6-2"
        stroke={FEATHERS}
        strokeWidth=".9"
        strokeLinecap="round"
        fill="none"
      />
      <Eye />
      <Eye mirrored />
      {/* Broad flat beak with droopy pink corners */}
      <path
        d="M11.8 24.2c.9-3.2 4.5-5 8.2-5s7.3 1.8 8.2 5c.3 1-.3 1.7-1.2 1.6-2.3-.4-4.6-.6-7-.6s-4.7.2-7 .6c-.9.1-1.5-.6-1.2-1.6z"
        fill="#e8a49c"
      />
      <path
        d="M14.6 23.2c1.2-1.9 3.2-2.9 5.4-2.9s4.2 1 5.4 2.9c-1.7.5-3.5.8-5.4.8s-3.7-.3-5.4-.8z"
        fill="#cbbba5"
      />
      <path
        d="M18.6 20.7c.3-.5.8-.7 1.4-.7s1.1.2 1.4.7c-.2 1.1-.7 1.8-1.4 1.8s-1.2-.7-1.4-1.8z"
        fill="#9a8f82"
      />
      <path
        d="M12.6 24.4c2.4-.9 4.9-1.3 7.4-1.3s5 .4 7.4 1.3"
        stroke="#8c4f49"
        strokeWidth=".75"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M12.6 24.4c-.6.5-.9 1.2-.9 2M27.4 24.4c.6.5.9 1.2.9 2"
        stroke="#d98b84"
        strokeWidth="1"
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
