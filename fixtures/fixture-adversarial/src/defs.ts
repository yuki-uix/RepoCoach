// A real, safe symbol the entry outline must be able to resolve through the
// barrel — the "attack did not land" control against which the escaping
// specifiers in import-specifiers.ts are judged.
export function safeSymbol(): string {
  return "safe";
}
