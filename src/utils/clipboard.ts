import { getPlatform } from "../platform/index.js";

export function copyToClipboard(text: string): Promise<boolean> {
  return getPlatform().copyToClipboard(text);
}
