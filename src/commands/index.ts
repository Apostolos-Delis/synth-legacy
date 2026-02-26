import type { CommandModule } from "yargs";

import startCommand from "./start.js";
import resumeCommand from "./resume.js";

import lsCommand from "./ls.js";
import sessionCommand from "./session.js";
import logsCommand from "./logs.js";
import statusCommand from "./status.js";
import psCommand from "./ps.js";
import configCommand from "./config.js";
import doctorCommand from "./doctor.js";
import themesCommand from "./themes.js";

import initCommand from "./init.js";
import rmCommand from "./rm.js";
import cleanCommand from "./clean.js";
import updateCommand from "./update.js";
import versionCommand from "./version.js";

// Some command modules define local CommandModule interfaces that are
// structurally incompatible with yargs' generic. Assert the full array.
export const commands = [
  startCommand,
  resumeCommand,
  lsCommand,
  sessionCommand,
  logsCommand,
  statusCommand,
  psCommand,
  configCommand,
  doctorCommand,
  themesCommand,
  initCommand,
  rmCommand,
  cleanCommand,
  updateCommand,
  versionCommand,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as CommandModule<any, any>[];

export const commandCategories: Record<string, string[]> = {
  "Workflow Commands:": ["start", "resume"],
  "Inspect Commands:": ["ls", "session", "logs", "status", "ps", "config", "doctor", "themes"],
  "System Commands:": ["init", "rm", "clean", "update", "version"],
};

export {
  startCommand,
  resumeCommand,
  lsCommand,
  sessionCommand,
  logsCommand,
  statusCommand,
  psCommand,
  configCommand,
  doctorCommand,
  themesCommand,
  initCommand,
  rmCommand,
  cleanCommand,
  updateCommand,
  versionCommand,
};
