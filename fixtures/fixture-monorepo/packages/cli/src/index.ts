/**
 * @mc/cli — the CLI package entry point.
 *
 * `main` parses argv and dispatches to a command.
 */

import { runCommand } from "./command";

/** Parse command-line arguments and run the matching command. */
export function main(argv: string[]): void {
  runCommand(argv[0] ?? "help");
}
