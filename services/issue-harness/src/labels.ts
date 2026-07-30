export const labels = {
  backlog: "ai:backlog",
  todo: "ai:todo",
  running: "ai:running",
  finished: "ai:finished",
  needsHuman: "ai:needs-human",
} as const;

export const labelColors: Record<string, string> = {
  [labels.backlog]: "ededed",
  [labels.todo]: "2f80ed",
  [labels.running]: "f2c94c",
  [labels.finished]: "27ae60",
  [labels.needsHuman]: "eb5757",
};

export const statusLabels = [
  labels.backlog,
  labels.todo,
  labels.running,
  labels.finished,
  labels.needsHuman,
];
