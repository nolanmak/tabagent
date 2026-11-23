// Messages to open extension pages (the pairing screen). The live action feed is #14.
export function broadcast(msg: unknown) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      /* no UI open */
    });
  } catch {
    /* no runtime (tests) */
  }
}
