export type SpinnerPreset =
  | "dots"
  | "braille"
  | "line"
  | "moon"
  | "bounce"
  | "arc"
  | "box"
  | "arrows";

export const SPINNER_PRESETS: Record<SpinnerPreset, string[]> = {
  dots: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line: ["-", "\\", "|", "/"],
  moon: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
  bounce: ["⠁", "⠂", "⠄", "⠂"],
  arc: ["◜", "◠", "◝", "◞", "◡", "◟"],
  box: ["▖", "▘", "▝", "▗"],
  arrows: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"],
};

export function getSpinnerFrames(name: string): string[] {
  const frames = SPINNER_PRESETS[name as SpinnerPreset];
  if (!frames) {
    throw new Error(
      `Unknown spinner preset "${name}". Available: ${listSpinnerPresets().join(", ")}`,
    );
  }
  return frames;
}

export function listSpinnerPresets(): SpinnerPreset[] {
  return Object.keys(SPINNER_PRESETS) as SpinnerPreset[];
}
