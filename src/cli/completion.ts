import { noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * `space completion zsh|bash`: a completion script generated from the same
 * command table the help prints, so it never lags a verb. Nouns and verbs
 * complete; arguments are left to the shell's file completion.
 *
 *   eval "$(space completion zsh)"      # in ~/.zshrc
 *   eval "$(space completion bash)"     # in ~/.bashrc
 */

export function renderCompletion(shell: string, nouns: Noun[]): string {
  const table = nouns.map((n) => ({ name: n.name, verbs: Object.keys(n.verbs).filter((v) => !(n.defaultVerb && Object.keys(n.verbs).length === 1)) }));
  const nounWords = [...table.map((n) => n.name), "help"].join(" ");
  if (shell === "zsh") {
    const cases = table
      .filter((n) => n.verbs.length)
      .map((n) => `      ${n.name}) _values 'verb' ${n.verbs.map((v) => `'${v}'`).join(" ")} 'help' ;;`)
      .join("\n");
    return [
      "#compdef space",
      "_space() {",
      "  local -a nouns",
      `  nouns=(${nounWords})`,
      "  if (( CURRENT == 2 )); then",
      "    _describe 'command' nouns",
      "  elif (( CURRENT == 3 )); then",
      "    case $words[2] in",
      cases,
      "      *) _files ;;",
      "    esac",
      "  else",
      "    _files",
      "  fi",
      "}",
      "compdef _space space",
      "",
    ].join("\n");
  }
  if (shell === "bash") {
    const cases = table
      .filter((n) => n.verbs.length)
      .map((n) => `      ${n.name}) COMPREPLY=($(compgen -W "${n.verbs.join(" ")} help" -- "$cur")) ;;`)
      .join("\n");
    return [
      "_space() {",
      "  local cur=${COMP_WORDS[COMP_CWORD]}",
      "  if [ $COMP_CWORD -eq 1 ]; then",
      `    COMPREPLY=($(compgen -W "${nounWords}" -- "$cur"))`,
      "  elif [ $COMP_CWORD -eq 2 ]; then",
      "    case ${COMP_WORDS[1]} in",
      cases,
      "      *) COMPREPLY=() ;;",
      "    esac",
      "  fi",
      "}",
      "complete -o default -F _space space",
      "",
    ].join("\n");
  }
  throw new UsageError("SHELL must be zsh or bash");
}

export const completionNoun: Noun = {
  name: "completion",
  summary: "shell completion: eval \"$(space completion zsh)\"",
  defaultVerb: "print",
  verbs: {
    print: {
      usage: "zsh|bash",
      summary: "the completion script for that shell",
      run: async (ctx: Ctx, argv: string[]) => {
        const { positional } = parseArgs(argv, {});
        noMore(positional, 1);
        const { NOUNS } = await import("./main.ts");
        ctx.io.write(renderCompletion(positional[0] ?? "", NOUNS));
        return 0;
      },
    },
  },
};
