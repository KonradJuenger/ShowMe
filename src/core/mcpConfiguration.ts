export const mcpConfigurationFormats = [
  { id: "codex", label: "Codex (TOML)" },
  { id: "json", label: "MCP clients (JSON)" },
  { id: "vscode", label: "VS Code (JSON)" },
] as const;

export function formatMcpConfiguration(
  configuration: string,
  format: (typeof mcpConfigurationFormats)[number]["id"],
) {
  const { showme } = JSON.parse(configuration).mcpServers as {
    showme: { command: string; args: string[] };
  };
  if (format === "json")
    return JSON.stringify({ mcpServers: { showme } }, null, 2);
  if (format === "vscode")
    return JSON.stringify(
      { servers: { showme: { type: "stdio", ...showme } } },
      null,
      2,
    );
  // TOML basic strings share JSON's escapes; DEL must also be escaped in TOML.
  const quote = (value: string) =>
    JSON.stringify(value).replace(/\x7f/g, "\\u007f");
  return `[mcp_servers.showme]\ncommand = ${quote(showme.command)}\nargs = [${showme.args.map(quote).join(", ")}]\n`;
}
