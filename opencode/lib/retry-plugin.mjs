function replaceText(output, text) {
  output.parts.splice(0, output.parts.length, { type: "text", text });
}

function retryCommand(argumentsText) {
  return `/retry${argumentsText ? ` ${argumentsText}` : ""}`;
}

function commandEnvelope(message, argumentsText) {
  return `${message}\n\n${retryCommand(argumentsText)}`;
}

export function createRetryHooks({ requestRetry, harnessUrl, commandToken }) {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "retry") return;
      try {
        const result = await requestRetry({
          parentSessionId: input.sessionID,
          instruction: input.arguments,
          harnessUrl,
          commandToken,
        });
        replaceText(output, commandEnvelope(result.accepted
          ? `Повторный запуск Issue #${result.issueNumber} поставлен в очередь.`
          : "В этом чате сейчас нечего повторять: технической ошибки с доступным восстановлением нет.", input.arguments));
      } catch {
        replaceText(output, commandEnvelope(
          "Не удалось повторить задачу. Harness или GitHub временно недоступен. Попробуйте ещё раз.",
          input.arguments,
        ));
      }
    },
  };
}
