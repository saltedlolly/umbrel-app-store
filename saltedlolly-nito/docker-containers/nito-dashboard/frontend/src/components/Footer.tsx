import type { VersionInfo } from "../api.js";

function reportIssueUrl(version: string): string {
  const body = [
    "**App:** Nito (saltedlolly App Store)",
    `**Version:** ${version}`,
    "",
    "> Before reporting, please make sure you are running the latest version: open the App Store on your Umbrel and install any update for Nito. The problem may already be fixed.",
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
    "**Relevant lines from the app's logs** (please remove anything private, such as IP addresses)",
    "```",
    "",
    "```",
  ].join("\n");
  const params = new URLSearchParams({ title: "[Nito] ", body });
  return `https://github.com/saltedlolly/umbrel-app-store/issues/new?${params}`;
}

export function Footer({ version }: { version: VersionInfo | null }) {
  const running = version?.version ?? "unknown";
  return (
    <footer className="page-footer">
      <div className="footer-grid">
        <div className="footer-about">
          <div>
            <a href="https://github.com/saltedlolly/umbrel-app-store/tree/master/saltedlolly-nito" target="_blank" rel="noopener noreferrer">
              Nito for Umbrel
            </a>{" "}
            by{" "}
            <a href="https://saltedlolly.com" target="_blank" rel="noopener noreferrer">
              saltedlolly
            </a>
            .
          </div>
          <div>
            Powered by{" "}
            <a href="https://github.com/NitoNetwork/Nito-core" target="_blank" rel="noopener noreferrer">
              Nito Core
            </a>
            . <span className="badge">{running}</span>
            {version?.updateAvailable && (
              <span className="badge badge-update" title="Install it from the App Store on your Umbrel (it can take a few minutes to appear there).">
                Update available: {version.latestVersion}
              </span>
            )}
          </div>
          <div className="footer-credit">
            Country lookups by{" "}
            <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
              DB-IP
            </a>
            , done on your Umbrel.
          </div>
        </div>
        <div className="footer-issue">
          <a className="button-outline" href={reportIssueUrl(running)} target="_blank" rel="noopener noreferrer">
            🐛 Report Issue
          </a>
        </div>
        <div className="footer-support">
          <span className="support-text">
            Please support
            <br />
            open source development
          </span>
          <a
            className="donate-button"
            href="https://ko-fi.com/saltedlolly"
            target="_blank"
            rel="noopener noreferrer"
            data-support-dialog=""
            aria-haspopup="dialog"
            title="Ways to support saltedlolly's open source apps"
          >
            <span className="donate-heart" aria-hidden="true">
              ♥
            </span>
            Donate
          </a>
          <a href="https://saltedlolly.com" target="_blank" rel="noopener noreferrer" title="saltedlolly.com">
            <img
              src="/saltedlolly-avatar-64.png"
              srcSet="/saltedlolly-avatar-64.png 1x, /saltedlolly-avatar-128.png 2x"
              width="32"
              height="32"
              alt="saltedlolly"
            />
          </a>
        </div>
      </div>
    </footer>
  );
}
