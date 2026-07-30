import { issueCommandMessage } from "./issue.mjs";

function replaceText(output, text) {
  output.parts.splice(0, output.parts.length, { type: "text", text });
}

function issueCommand(argumentsText) {
  return `/issue${argumentsText ? ` ${argumentsText}` : ""}`;
}

function commandEnvelope(message, argumentsText) {
  return `${message}\n\n${issueCommand(argumentsText)}`;
}

export function createIssueHooks({ createIssue, harnessUrl, commandToken }) {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "issue") return;
      try {
        const result = await createIssue({
          argumentsText: input.arguments,
          parentSessionId: input.sessionID,
          harnessUrl,
          commandToken,
        });
        if (result.busy) {
          replaceText(output, commandEnvelope(result.issueNumber
            ? `Нельзя создать новый Issue: Issue #${result.issueNumber} уже выполняется или ожидает выполнения. Дождитесь его завершения.`
            : "Нельзя создать новый Issue: другая задача уже выполняется или ожидает выполнения. Дождитесь её завершения.", input.arguments));
          return;
        }
        replaceText(output, issueCommandMessage(result.number, input.arguments));
      } catch {
        replaceText(output, commandEnvelope(
          "Не удалось создать Issue. Harness или GitHub временно недоступен. Попробуйте отправить команду ещё раз.",
          input.arguments,
        ));
      }
    },
  };
}
