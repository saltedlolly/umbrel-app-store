import Avatar from "./Avatar";
import CopyText from "./utility/CopyText";
import { shortNpub } from "../nostr";

// "(avatar) @olly.st Latest actions", with the account's npub beneath it
export default function AccountHeading({ column }) {
  return (
    <span className="flex items-center gap-3 min-w-0">
      <Avatar
        picture={column.picture}
        label={column.label}
        other={column.other}
        size="w-10 h-10"
      />
      <span className="flex flex-col min-w-0">
        <span className="break-words">
          {column.other ? "Other accounts" : column.label}{" "}
          <span className="font-normal whitespace-nowrap text-slate-500 dark:text-slate-400">
            Latest actions
          </span>
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
    </span>
  );
}
