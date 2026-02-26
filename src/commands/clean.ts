import type { CommandModule } from "yargs";
import { deleteSession, listSessions } from "../sessions/registry.js";
import { ansi, fmt } from "../tui/theme.js";
import rmCommand from "./rm.js";

const cleanCommand: CommandModule = {
  command: "clean",
  describe: "Remove interview sessions and stale sessions",
  builder: (yargs) =>
    yargs
      .example("synth clean", "Remove interview sessions (with prompt) and stale sessions")
      .example("synth clean", "Same as synth rm --stale, plus interview cleanup"),
  async handler() {
    const cwd = process.cwd();
    const sessions = await listSessions(cwd);
    const interviewSessions = sessions.filter((s) => s.status === "interviewing");

    if (interviewSessions.length > 0) {
      console.log(fmt.bold(`Found ${interviewSessions.length} interview session(s):\n`));
      for (const s of interviewSessions) {
        const date = fmt.dim(new Date(s.updatedAt).toLocaleDateString());
        console.log(`${s.id} ${ansi.muted}(${s.status}, last updated ${date})${ansi.reset}`);
      }

      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`\nRemove all interview sessions? (y/N) `, resolve);
      });
      rl.close();

      const normalized = answer.trim().toLowerCase();
      if (normalized === "y" || normalized === "yes") {
        console.log("");
        for (const s of interviewSessions) {
          const date = fmt.dim(new Date(s.updatedAt).toLocaleDateString());
          const deleted = await deleteSession(cwd, s.id);
          if (deleted) {
            console.log(fmt.success(`${s.id} ${ansi.muted}(${s.status}, last updated ${date})${ansi.reset}`));
          } else {
            console.error(fmt.error(`${s.id} — not found on disk`));
          }
        }
      }
    }

    await rmCommand.handler({ ids: [], stale: true, _: ["clean"], $0: "" });
  },
};

export default cleanCommand;
