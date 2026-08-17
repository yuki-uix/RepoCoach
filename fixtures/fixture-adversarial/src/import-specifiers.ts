// Attack 5: out-of-bounds import specifiers.
//
// A barrel / import graph that names paths outside the repository. The resolver
// must never follow `..` escapes or absolute specifiers: it normalises with
// joinPosix (which rejects an escape above the repo root) and only ever returns
// a path that actually appears in the reader's tree. The safe re-export below
// is the control — it must still resolve while the escapes must not be read.
export * from "./defs.js";
export * from "../../../etc/passwd";
import * as passwd from "/etc/passwd";
