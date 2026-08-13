# taskloom

A minimal task tracking library. taskloom turns raw strings such as
`"fix login bug @alice !high #in_progress"` into structured, validated tasks
and renders them back as a single line of text.

> taskloom is a **fixture**, not a real library. It exists only to give
> RepoCoach a stable, self-contained codebase to trace and evaluate against.

## Features

- Parse a raw task string into fields (`title`, `assignee`, `priority`,
  `status`).
- Validate tasks before they are stored.
- Store tasks in memory.
- Render tasks as a single line of text.
- Export tracked tasks to CSV.

## Usage

```ts
import { createTracker } from "./src/index";

const tracker = createTracker();
tracker.add("fix login bug @alice !high");
// => "[todo] #1 fix login bug (alice, high)"
```

## Exporting to CSV

Use the export feature to dump all tracked tasks into a CSV file:

```ts
const tracker = createTracker();
tracker.add("ship docs");
tracker.exportToCsv("tasks.csv");
```

The CSV columns are `id`, `title`, `assignee`, `priority` and `status`.
