import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { FormEvent, useState } from "react";
import type { Id } from "../convex/_generated/dataModel";

type AppProps = {
  missingConvexUrl?: boolean;
};

export function App({ missingConvexUrl = false }: AppProps) {
  return (
    <main className="shell">
      <section className="panel">
        <div className="eyebrow">Convex demo</div>
        <h1>Harness Tasks</h1>
        <p className="lede">
          A tiny realtime task board for proving the app deployment while the issue harness works in the background.
        </p>

        {missingConvexUrl ? (
          <div className="notice">Set VITE_CONVEX_URL after creating the Convex deployment.</div>
        ) : (
          <TaskBoard />
        )}
      </section>
    </main>
  );
}

function TaskBoard() {
  const tasks = useQuery(listTasks) ?? [];
  const createTask = useMutation(createTaskMutation);
  const toggleTask = useMutation(toggleTaskMutation);
  const [title, setTitle] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    await createTask({ title: trimmed });
    setTitle("");
  }

  return (
    <>
      <form className="composer" onSubmit={onSubmit}>
        <input
          aria-label="Task title"
            placeholder="Add a task"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit">Add</button>
        </form>

        <ul className="tasks">
          {tasks.map((task) => (
            <li key={task._id} className={task.done ? "done" : ""}>
              <label>
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={() => void toggleTask({ id: task._id, done: !task.done })}
                />
                <span>{task.title}</span>
              </label>
            </li>
          ))}
        </ul>
    </>
  );
}

type DemoTask = {
  _id: Id<"tasks">;
  _creationTime: number;
  title: string;
  done: boolean;
};

const listTasks = makeFunctionReference<"query", Record<string, never>, DemoTask[]>("tasks:list");
const createTaskMutation = makeFunctionReference<"mutation", { title: string }, null>("tasks:create");
const toggleTaskMutation = makeFunctionReference<"mutation", { id: Id<"tasks">; done: boolean }, null>(
  "tasks:toggle",
);
