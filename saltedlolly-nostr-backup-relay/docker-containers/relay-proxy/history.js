import fse from "fs-extra";

// The relay keeps only the newest profile (kind 0) and relay list (kind 10002)
// for each account, so the dashboard couldn't show what changed. This keeps
// every version the relay proxy sees for the synced accounts, in
// data/history.json, so each update can be compared with the one before.
export const HISTORY_FILE = "./data/history.json";
export const HISTORY_KINDS = [0, 10002];
// Per account and kind; the oldest versions are dropped first
const MAX_VERSIONS = 50;

export default class History {
  constructor({ file = HISTORY_FILE, saveDelay = 2000 } = {}) {
    this.file = file;
    this.saveDelay = saveDelay;
    this.timer = null;
    this.data = {};
    try {
      const saved = fse.readJsonSync(file);
      if (saved && typeof saved === "object" && !Array.isArray(saved)) this.data = saved;
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Could not read the profile history:", error.message);
    }
  }

  // Records a verified event. Returns true if it was a version we hadn't seen.
  record(event) {
    if (!HISTORY_KINDS.includes(event.kind)) return false;
    const kinds = (this.data[event.pubkey] ??= {});
    const versions = (kinds[event.kind] ??= []);
    if (versions.some(version => version.id === event.id)) return false;
    const { id, pubkey, kind, created_at, content, tags, sig } = event;
    versions.push({ id, pubkey, kind, created_at, content, tags, sig });
    versions.sort((a, b) => a.created_at - b.created_at);
    if (versions.length > MAX_VERSIONS) versions.splice(0, versions.length - MAX_VERSIONS);
    this.scheduleSave();
    return true;
  }

  // { [pubkey]: [every saved version, oldest first] } for the given accounts
  versions(pubkeys) {
    const result = {};
    for (const pubkey of pubkeys) {
      const kinds = this.data[pubkey];
      if (!kinds) continue;
      result[pubkey] = Object.values(kinds).flat().sort((a, b) => a.created_at - b.created_at);
    }
    return result;
  }

  // Called when an account stops being synced
  forget(pubkey) {
    if (!pubkey || !this.data[pubkey]) return;
    delete this.data[pubkey];
    this.scheduleSave();
  }

  clear() {
    this.data = {};
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), this.saveDelay);
    this.timer.unref?.();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      if (Object.keys(this.data).length === 0) {
        fse.removeSync(this.file);
        return;
      }
      // Write a temporary file and rename it, so a crash can't leave half a file
      const temporary = `${this.file}.tmp`;
      fse.writeJsonSync(temporary, this.data);
      fse.renameSync(temporary, this.file);
    } catch (error) {
      console.error("Could not save the profile history:", error.message);
    }
  }

  close() {
    if (this.timer) this.save();
  }
}
