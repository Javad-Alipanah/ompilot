export type OmpSlashCommandSource =
  | "builtin"
  | "skill"
  | "extension"
  | "custom"
  | "mcp_prompt"
  | "file"
  | "prompt"
  | "unknown";

/** Public command metadata only; prompt bodies and filesystem paths stay in OMP. */
export interface OmpSlashCommand {
  /** Exact RPC command name without the leading slash, including skill namespaces. */
  name: string;
  description?: string;
  source: OmpSlashCommandSource;
  aliases?: string[];
  input?: { hint: string };
  subcommands?: Array<{ name: string; description?: string; usage?: string }>;
}

const sources = new Set<string>([
  "builtin",
  "skill",
  "extension",
  "custom",
  "mcp_prompt",
  "file",
  "prompt",
  "unknown",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function commandName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

/** Preserve OMP's command precedence while accepting only documented metadata. */
export function normalizeCommandCatalog(value: unknown): OmpSlashCommand[] {
  if (!Array.isArray(value)) throw new Error("OMP returned an invalid command catalog");
  const commands: OmpSlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = record(item);
    if (!entry || !commandName(entry.name) || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const source =
      typeof entry.source === "string" && sources.has(entry.source)
        ? (entry.source as OmpSlashCommandSource)
        : entry.name.startsWith("skill:")
          ? "skill"
          : "unknown";
    const command: OmpSlashCommand = { name: entry.name, source };
    if (typeof entry.description === "string") command.description = entry.description;
    if (Array.isArray(entry.aliases)) {
      const aliases = entry.aliases.filter(commandName);
      if (aliases.length) command.aliases = aliases;
    }
    const input = record(entry.input);
    if (typeof input?.hint === "string") command.input = { hint: input.hint };
    if (Array.isArray(entry.subcommands)) {
      const subcommands: NonNullable<OmpSlashCommand["subcommands"]> = [];
      for (const item of entry.subcommands) {
        const subcommand = record(item);
        if (!subcommand || !commandName(subcommand.name)) continue;
        const metadata: NonNullable<OmpSlashCommand["subcommands"]>[number] = {
          name: subcommand.name,
        };
        if (typeof subcommand.description === "string")
          metadata.description = subcommand.description;
        if (typeof subcommand.usage === "string") metadata.usage = subcommand.usage;
        subcommands.push(metadata);
      }
      if (subcommands.length) command.subcommands = subcommands;
    }
    commands.push(command);
  }
  return commands;
}
