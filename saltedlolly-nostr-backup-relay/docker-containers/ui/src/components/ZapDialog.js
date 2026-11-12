import qrcode from "qrcode-generator";
import Dialog from "./Dialog";
import CopyText from "./utility/CopyText";

// Tips in sats to saltedlolly over Lightning. zaps@olly.st is a Lightning
// address that also accepts Nostr zaps (NIP-57).
export const ZAP_ADDRESS = "zaps@olly.st";
const NOSTR_PROFILE =
  "https://njump.me/npub15fy9pt2tuh5nt3u2a9euhftx29x46vzma8pknx5ecj8r6eu8j6hsaakfqk";

// The QR code as one SVG path, drawn from the generator's grid of modules
function QrCode({ text }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return (
    <svg
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="w-44 h-44 rounded-lg bg-white"
      role="img"
      aria-label={`QR code for ${text}`}
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#0f172a" />
    </svg>
  );
}

const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium";

export default function ZapDialog({ onClose }) {
  return (
    <Dialog title="Zap saltedlolly" onClose={onClose}>
      <div className="px-6 sm:px-10 py-5 grid gap-4 justify-items-center text-center text-sm text-slate-700 dark:text-slate-300">
        <p>
          Nostr Backup Relay is free. If you find it useful, you can send
          saltedlolly a tip in sats over Lightning. Tips are always optional.
        </p>
        <QrCode text={`lightning:${ZAP_ADDRESS}`} />
        <div className="flex items-center gap-2">
          <span className="text-slate-500 dark:text-slate-400">
            Lightning address:
          </span>
          <CopyText value={ZAP_ADDRESS} />
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <a
            href={`lightning:${ZAP_ADDRESS}`}
            className={`${button} text-white bg-[#2d333b] hover:bg-black dark:text-slate-900 dark:bg-[#e6e9ee] dark:hover:bg-white`}
          >
            ⚡ Open in wallet
          </a>
          <a
            href={NOSTR_PROFILE}
            target="_blank"
            rel="noopener noreferrer"
            className={`${button} text-slate-700 dark:text-slate-200 ring-1 ring-slate-900/15 dark:ring-white/15 hover:bg-slate-100 dark:hover:bg-white/10`}
          >
            Zap @olly.st on Nostr
          </a>
        </div>
      </div>
    </Dialog>
  );
}
