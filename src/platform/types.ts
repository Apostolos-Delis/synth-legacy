export interface SleepInhibitor {
  release(): void;
}

export interface PlatformProvider {
  readonly name: string;

  inhibitSleep(reason: string): SleepInhibitor;

  copyToClipboard(text: string): Promise<boolean>;

  getAvailableDiskMb(path: string): Promise<number>;

  defaultEditor(): string;

  installHint(tool: string): string;
}
