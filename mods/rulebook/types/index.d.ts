export type Rule = {
  id: string
  // Regex on the tool name, e.g. ^Bash$ or ^(Edit|Write)$
  tool: string
  // Which input field the pattern reads: a field name like command or file_path, or * for the whole input
  field: string
  pattern: string
  flags?: string
  // deny refuses the call; confirm asks the user first
  action: 'deny' | 'confirm'
  message: string
  why?: string
  added: string
}

declare module 'claude-code' {
  interface PluginState {
    rulebook: { rules: Rule[] }
  }
}
