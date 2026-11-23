// Live activity feed for the side panel (#14). Entries are audit records (D20),
// already redacted by the router; nothing else is shown.
import { feedReducer, type FeedEntry } from "../ui/reducers";

export type { FeedEntry };

let entries: FeedEntry[] = [];

export function feedPush(e: FeedEntry) {
  entries = feedReducer(entries, e);
  broadcast({ type: "feed", entry: e });
}

export function feedAll(): FeedEntry[] {
  return entries.slice();
}

export function broadcast(msg: unknown) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      /* no UI open */
    });
  } catch {
    /* no runtime (tests) */
  }
}
