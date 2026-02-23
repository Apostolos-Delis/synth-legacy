/**
 * Standalone visual harness for OptionSelector.
 * Run with: bun run src/__tests__/option-selector-harness.tsx
 *        or: bun run src/__tests__/option-selector-harness.tsx --multi
 *
 * Tests:
 *   - Up/Down arrows navigate without scrolling the parent
 *   - "(Recommended)" badge is visible
 *   - Enter selects the highlighted option
 *   - Number keys 1-5 jump to options
 *   - "Other..." opens textarea input
 *   - Tab/Shift+Tab switches between question groups (--multi mode)
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ChatOption, QuestionGroup } from "../finalize/chat-types.js";
import { OptionSelector } from "../tui/components/OptionSelector.js";
import { colors, boldAttr } from "../tui/theme.js";

const SINGLE_GROUP: QuestionGroup[] = [
  {
    question: "How should we handle the authentication flow?",
    options: [
      { label: "OAuth 2.0 with PKCE", description: "Industry-standard authorization flow for public clients, provides refresh tokens", value: "oauth", recommended: true },
      { label: "API Key", description: "Simple static key authentication, suitable for server-to-server", value: "apikey" },
      { label: "JWT with short-lived tokens", description: "Stateless authentication with 15-minute token expiry and refresh rotation", value: "jwt" },
      { label: "Session cookies", description: "Traditional server-side sessions with httpOnly secure cookies", value: "cookies" },
    ],
  },
];

const MULTI_GROUP: QuestionGroup[] = [
  {
    question: "Select a database engine",
    options: [
      { label: "PostgreSQL", description: "Full-featured relational database with JSON support", value: "pg", recommended: true },
      { label: "SQLite", description: "Lightweight embedded database, zero-config", value: "sqlite" },
      { label: "MySQL", description: "Widely deployed relational database", value: "mysql" },
    ],
  },
  {
    question: "Select a caching strategy",
    options: [
      { label: "Redis", description: "In-memory key-value store with pub/sub", value: "redis", recommended: true },
      { label: "In-process LRU", description: "Simple in-memory cache, no external dependency", value: "lru" },
    ],
  },
];

const mode = process.argv.includes("--multi") ? "multi" : "single";

function HarnessApp() {
  const groups = mode === "single" ? SINGLE_GROUP : MULTI_GROUP;

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
      {/* Header */}
      <box style={{ width: "100%", height: 3, border: true, borderColor: colors.border.normal, backgroundColor: colors.bg.secondary, paddingLeft: 1, alignItems: "center" }}>
        <text fg={colors.accent.primary} attributes={boldAttr()}>
          OptionSelector Harness — {mode === "single" ? "Single Question" : "Multi Question"}
        </text>
      </box>

      {/* Scrollable content to verify arrow keys don't leak */}
      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
        <scrollbox style={{ flexGrow: 1 }} stickyScroll={true} stickyStart="bottom">
          <text fg={colors.fg.muted}>This is filler content above the options.</text>
          <text fg={colors.fg.muted}>If arrow keys leak, this scrollbox will scroll.</text>
          <text fg={colors.fg.muted}>---</text>
          {Array.from({ length: 20 }, (_, i) => (
            <text key={i} fg={colors.fg.dim}>Filler line {i + 1} — should NOT scroll when pressing up/down</text>
          ))}
        </scrollbox>
      </box>

      {/* Option selector area */}
      <box
        style={{
          width: "100%",
          height: groups.reduce((s, g) => s + (g.options.length + 1) * 3, 0) + (groups[0]?.question ? 2 : 0) + (groups.length > 1 ? 2 : 0) + 1 + 4,
          flexDirection: "column",
          backgroundColor: colors.bg.secondary,
          border: true,
          borderColor: colors.border.active,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <OptionSelector
          groups={groups}
          onSelect={(answers: ChatOption[]) => {
            // biome-ignore lint: harness logging
            console.log("\n\x1b[32m✓ Selected:\x1b[0m", answers.map((a) => `${a.label} (${a.value})`).join(", "));
            process.exit(0);
          }}
        />
      </box>

      {/* Footer */}
      <box style={{ width: "100%", height: 1, justifyContent: "center", alignItems: "center" }}>
        <text fg={colors.fg.muted}>Esc: quit</text>
      </box>
    </box>
  );
}

async function main() {
  const renderer = await createCliRenderer({
    useAlternateScreen: true,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  });
  const root = createRoot(renderer);
  root.render(<HarnessApp />);
}

main();
