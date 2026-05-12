import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").order("desc").take(50);
  },
});

export const create = mutation({
  args: {
    title: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tasks", {
      title: args.title,
      done: false,
    });
  },
});

export const toggle = mutation({
  args: {
    id: v.id("tasks"),
    done: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      done: args.done,
    });
  },
});
