import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";

export const DEMO_BOUNDARY_ID = "public-disposable-task-board";
export const MAX_TASK_TITLE_LENGTH = 120;
export const MAX_DEMO_TASKS = 100;

const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  title: v.string(),
  done: v.boolean(),
});

function normalizeDemoTaskTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0 || normalized.length > MAX_TASK_TITLE_LENGTH) {
    throw new ConvexError({
      code: "INVALID_DEMO_TASK_TITLE",
      boundary: DEMO_BOUNDARY_ID,
      message: `Task titles must contain 1-${MAX_TASK_TITLE_LENGTH} characters`,
    });
  }
  return normalized;
}

export const list = query({
  args: {},
  returns: v.array(taskValidator),
  handler: async (ctx) => {
    return await ctx.db.query("tasks").order("desc").take(50);
  },
});

export const create = mutation({
  args: {
    title: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const title = normalizeDemoTaskTitle(args.title);
    const existingTasks = await ctx.db.query("tasks").take(MAX_DEMO_TASKS);
    if (existingTasks.length >= MAX_DEMO_TASKS) {
      throw new ConvexError({
        code: "DEMO_TASK_LIMIT_REACHED",
        boundary: DEMO_BOUNDARY_ID,
        message: `This disposable demo is limited to ${MAX_DEMO_TASKS} tasks`,
      });
    }
    await ctx.db.insert("tasks", {
      title,
      done: false,
    });
    return null;
  },
});

export const toggle = mutation({
  args: {
    id: v.id("tasks"),
    done: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      done: args.done,
    });
    return null;
  },
});
