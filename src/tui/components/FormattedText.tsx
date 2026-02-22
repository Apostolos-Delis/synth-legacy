import type { ReactNode } from "react";
import { colors } from "../theme.js";

export type SegmentColor = "blue" | "purple" | "cyan" | "green" | "yellow" | "pink" | "muted" | "default";

export interface FormattedSegment {
  text: string;
  color?: SegmentColor;
}

function getColorMap(): Record<SegmentColor, string> {
  return {
    blue: colors.accent.primary,
    purple: colors.accent.secondary,
    cyan: colors.status.info,
    green: colors.status.success,
    yellow: colors.status.warning,
    pink: colors.status.error,
    muted: colors.fg.muted,
    default: colors.fg.primary,
  };
}

export interface FormattedTextProps {
  segments: FormattedSegment[];
}

export function FormattedText({ segments }: FormattedTextProps): ReactNode {
  if (segments.length === 0) {
    return null;
  }

  const colorMap = getColorMap();
  const panelBg = colors.bg.secondary;

  return (
    <text fg={colorMap.default}>
      {segments.map((segment, index) => {
        const color = segment.color;
        if (!color || color === "default") {
          return segment.text;
        }

        return (
          <span key={index} fg={colorMap[color]} bg={panelBg}>
            {segment.text}
          </span>
        );
      })}
    </text>
  );
}
