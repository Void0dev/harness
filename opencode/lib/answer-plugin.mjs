export function createAnswerHooks({
  forward,
  harnessUrl,
  commandToken,
  onError = (error) => console.error("Harness answer forwarding failed", error),
}) {
  return {
    "chat.message": async (input, output) => {
      const text = output.parts.flatMap((part) =>
        part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
      if (!text) return;

      // Refresh stage in parallel so OpenCode can persist the optimistic user
      // turn immediately and show its native thinking state without flicker.
      void Promise.resolve().then(() => forward({
          text,
          parentSessionId: input.sessionID,
          harnessUrl,
          commandToken,
        })).catch(onError);
    },
  };
}
