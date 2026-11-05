/** Stored form of an image copied into the collection's assets folder. */
export const ASSET_PREFIX = "ir-asset:";
// Windows and Android webviews expose custom schemes as http://<scheme>.localhost/.
export const ASSET_BASE = /Windows|Android/i.test(navigator.userAgent) ? "http://irasset.localhost/" : "irasset://localhost/";

export const toDisplaySrc = (src: string | null) =>
  src && src.startsWith(ASSET_PREFIX) ? ASSET_BASE + src.slice(ASSET_PREFIX.length) : src;
export const toStoredSrc = (src: string | null) =>
  src && src.startsWith(ASSET_BASE) ? ASSET_PREFIX + src.slice(ASSET_BASE.length) : src;
