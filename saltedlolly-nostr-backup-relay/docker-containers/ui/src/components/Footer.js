import { useCallback, useEffect, useState } from "react";
import axios from "axios";

import { RELAY_PROXY_URL } from "../constants/constants";
import ZapDialog from "./ZapDialog";

const APP_NAME = "Nostr Backup Relay";
const APP_URL =
  "https://github.com/saltedlolly/umbrel-app-store/tree/master/saltedlolly-nostr-backup-relay";
const VERSION_CHECK_MS = 5 * 60 * 1000;

// "Report Issue" opens a new issue on the store, with the app and version filled in
function reportIssueLink(version) {
  const body = [
    `**App:** ${APP_NAME} (saltedlolly App Store)`,
    `**Version:** ${version}`,
    "",
    `> Before reporting, please make sure you are running the latest version: open the App Store on your Umbrel and install any update for ${APP_NAME}. The problem may already be fixed.`,
    "",
    "**What happened?**",
    "",
    "",
    "**What did you expect to happen?**",
    "",
    "",
    "**Steps to reproduce**",
    "",
    "",
    "**Relevant lines from the app's logs** (please remove anything private, such as IP addresses and domain names)",
    "```",
    "",
    "```",
  ].join("\n");
  const params = new URLSearchParams({ title: `[${APP_NAME}] `, body });
  return `https://github.com/saltedlolly/umbrel-app-store/issues/new?${params}`;
}

// Running version, and a notice when the app store has a newer version (the
// relay proxy checks the store every 10 minutes; the page asks it every 5)
function useVersion() {
  const [version, setVersion] = useState({ version: "unknown" });
  useEffect(() => {
    const refresh = () =>
      axios
        .get(`${RELAY_PROXY_URL}/version`)
        .then(({ data }) => setVersion(data))
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, VERSION_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  return version;
}

const link = "underline-offset-2 hover:underline";

export default function Footer({ relayVersion }) {
  const { version, latestVersion, updateAvailable } = useVersion();
  const [showZap, setShowZap] = useState(false);
  const closeZap = useCallback(() => setShowZap(false), []);

  return (
    <footer className="mt-10 min-[1200px]:mt-0 min-[1200px]:fixed min-[1200px]:bottom-0 min-[1200px]:inset-x-0 min-[1200px]:z-10 border-t border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900 px-4 py-2 text-sm text-slate-500 dark:text-slate-400">
      <div className="container mx-auto grid grid-cols-1 justify-items-center text-center gap-2 min-[1200px]:grid-cols-[1fr_auto_1fr] min-[1200px]:justify-items-stretch min-[1200px]:text-left min-[1200px]:items-center min-[1200px]:gap-4">
        <div>
          <div>
            <a
              href={APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              {APP_NAME}
            </a>{" "}
            by{" "}
            <a
              href="https://saltedlolly.com"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              saltedlolly
            </a>
            .
          </div>
          <div>
            Powered by{" "}
            <a
              href="https://github.com/getumbrel/umbrel-nostr-relay"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              Nostr Relay by Umbrel
            </a>{" "}
            and{" "}
            <a
              href="https://github.com/scsibug/nostr-rs-relay"
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              nostr-rs-relay{relayVersion ? ` ${relayVersion}` : ""}
            </a>
            .
            <span className="ml-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-slate-500 text-white dark:bg-slate-600">
              {version}
            </span>
            {updateAvailable && (
              <span
                className="ml-1 inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-amber-400 text-slate-900"
                title="Install it from the App Store on your Umbrel (it can take a few minutes to appear there)."
              >
                Update available: {latestVersion}
              </span>
            )}
          </div>
        </div>
        <div>
          <a
            href={reportIssueLink(version)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block whitespace-nowrap rounded-md border border-slate-400 dark:border-slate-500 px-2 py-0.5 hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            🐛 Report Issue
          </a>
        </div>
        {/* Tips in sats only: Donate buttons are on hold, and Umbrel's
            licence for this app's code is noncommercial (user, 2026-11-12) */}
        <div className="min-[1200px]:justify-self-end flex items-center gap-3">
          <div className="text-center leading-tight text-xs">
            Please support
            <br />
            open source development
          </div>
          <button
            type="button"
            onClick={() => setShowZap(true)}
            className="whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium text-white bg-[#2d333b] hover:bg-black dark:text-slate-900 dark:bg-[#e6e9ee] dark:hover:bg-white"
          >
            ⚡ Zap
          </button>
          <a
            href="https://saltedlolly.com"
            target="_blank"
            rel="noopener noreferrer"
            title="saltedlolly.com"
          >
            <img
              src="/saltedlolly-avatar-64.png"
              srcSet="/saltedlolly-avatar-64.png 1x, /saltedlolly-avatar-128.png 2x"
              width="32"
              height="32"
              alt="saltedlolly"
              className="block rounded-full"
            />
          </a>
        </div>
      </div>
      {showZap && <ZapDialog onClose={closeZap} />}
    </footer>
  );
}
