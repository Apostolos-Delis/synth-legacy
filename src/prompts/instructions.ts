import { getBuiltinTemplateOrDefault } from "../templates/index.js";
import Handlebars from "handlebars";

const compiled = Handlebars.compile(getBuiltinTemplateOrDefault("default"), {
  noEscape: true,
});

export function buildIterationInstructions(slug?: string): string {
  const scope = slug || "session-slug";
  return compiled({ slug: scope });
}
