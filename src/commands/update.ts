import type { CommandModule } from "yargs";
import { VERSION, REPO } from "./helpers.js";
import { fmt } from "../tui/theme.js";
import { createSpinner } from "../tui/spinner.js";

function detectPlatform(): { os: string; arch: string } {
  const platform = process.platform;
  const arch = process.arch;
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  const mappedArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : "";
  if (!os || !mappedArch) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return { os, arch: mappedArch };
}

function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function downloadAndInstall(
  tag: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const { os, arch } = detectPlatform();
  const binary = `synth-${os}-${arch}.gz`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${binary}`;

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) — check that a release exists for ${os}-${arch}`);
  }

  const contentLength = res.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : null;
  let received = 0;

  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }

  const compressed = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  const decompressed = Bun.gunzipSync(compressed);

  const installDir = process.env.SYNTH_INSTALL_DIR || `${process.env.HOME}/.local/bin`;
  const installPath = `${installDir}/synth`;

  const { mkdirSync, writeFileSync, chmodSync, renameSync } = await import("node:fs");
  mkdirSync(installDir, { recursive: true });
  const tmpPath = `${installPath}.tmp`;
  writeFileSync(tmpPath, decompressed);
  chmodSync(tmpPath, 0o755);
  renameSync(tmpPath, installPath);
}

const updateCommand: CommandModule = {
  command: "update",
  describe: "Update synth to the latest version",
  builder: (yargs) =>
    yargs
      .example("synth update", "Update synth to the latest release")
      .example("synth update", "Check for and install available updates"),
  async handler() {
    const tuiEnabled = process.stdout.isTTY === true && !process.argv.includes("--no-tui");

    let release: { tag_name: string };

    if (tuiEnabled) {
      const spinner = createSpinner("Checking for updates");
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
      if (!res.ok) {
        spinner.stop(fmt.error("Failed to check for updates"));
        process.exit(1);
      }
      release = (await res.json()) as { tag_name: string };
      const latest = release.tag_name.replace(/^v/, "");

      if (latest === VERSION) {
        spinner.stop(fmt.success(`Already on latest version (${VERSION})`));
        return;
      }

      spinner.stop(fmt.info(`New version available: ${VERSION} → ${latest}`));

      const updateSpinner = createSpinner("Downloading update...");
      try {
        await downloadAndInstall(release.tag_name, (received, total) => {
          if (total) {
            const pct = Math.round((received / total) * 100);
            updateSpinner.update(`Downloading update... ${formatBytes(received)} / ${formatBytes(total)} MB (${pct}%)`);
          } else {
            updateSpinner.update(`Downloading update... ${formatBytes(received)} MB`);
          }
        });
        updateSpinner.stop(fmt.success(`Updated to v${latest}`));
      } catch (err) {
        updateSpinner.stop(fmt.error(`Update failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    } else {
      console.log("Checking for updates...");
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
      if (!res.ok) {
        console.error(fmt.error("Failed to check for updates"));
        process.exit(1);
      }
      release = (await res.json()) as { tag_name: string };
      const latest = release.tag_name.replace(/^v/, "");

      if (latest === VERSION) {
        console.log(`Already on latest version (${VERSION})`);
        return;
      }

      console.log(`New version available: ${VERSION} → ${latest}`);
      console.log("Downloading...");

      try {
        await downloadAndInstall(release.tag_name, (received, total) => {
          if (total) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(`\r  ${formatBytes(received)} / ${formatBytes(total)} MB (${pct}%)`);
          }
        });
        process.stdout.write("\n");
        console.log(fmt.success(`Updated to v${latest}`));
      } catch (err) {
        process.stdout.write("\n");
        console.error(fmt.error(`Update failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    }
  },
};

export default updateCommand;
