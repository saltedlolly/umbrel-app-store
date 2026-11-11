import Avatar from "./Avatar";
import CopyText from "./utility/CopyText";
import { shortNpub } from "../nostr";

// "(avatar) @olly.st" with the account's npub beneath it, and a More button
// that opens all of the account's actions
export default function AccountHeading({ column, onMore, onDelete }) {
  return (
    <span className="flex items-center gap-3 min-w-0">
      <Avatar
        pubkey={column.key}
        picture={column.picture}
        label={column.label}
        other={column.other}
        size="w-10 h-10"
      />
      <span className="flex flex-col min-w-0 flex-1">
        <span className="break-words">
          {column.other ? "Other accounts" : column.label}
        </span>
        {column.npub ? (
          <span className="text-sm font-normal mt-1 self-start">
            <CopyText value={column.npub} display={shortNpub(column.npub)} />
          </span>
        ) : column.other ? (
          <span className="text-sm font-normal mt-1 text-slate-500 dark:text-slate-400">
            Saved by accounts that aren&apos;t synced
          </span>
        ) : null}
      </span>
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          title="Delete everything saved by these accounts"
          aria-label="Delete everything saved by other accounts"
          className="flex-none self-start inline-flex items-center rounded-md p-1.5 text-red-600 dark:text-red-400 bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/10 hover:bg-red-50 dark:hover:bg-red-500/15"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
          </svg>
        </button>
      ) : null}
      {onMore ? (
        <button
          type="button"
          onClick={onMore}
          title="Show all actions"
          className="flex-none self-start inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/10 hover:bg-[#CEC8F4] dark:hover:bg-[#264D96]"
        >
          More
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5" />
          </svg>
        </button>
      ) : null}
    </span>
  );
}
