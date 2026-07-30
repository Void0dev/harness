import { OpenCodeSessionError } from "./opencode-client.js";

export function workerFailureQuestion(error: unknown) {
  if (error instanceof OpenCodeSessionError) {
    if (error.code === "model_authentication") {
      return "Нейросеть отклонила API-ключ: он недействителен или был аннулирован. Обновите VOID_AI_API_KEY и перезапустите Harness, затем отправьте /retry в этом чате.";
    }
    if (error.code === "model_rate_limit") {
      return "Нейросеть временно отклонила запрос из-за ограничения частоты. Подождите и отправьте /retry в этом чате.";
    }
    if (error.code === "model_unavailable") {
      return "Шлюз нейросети временно недоступен. После восстановления соединения отправьте /retry в этом чате.";
    }
    return "Нейросеть завершила рабочую сессию с ошибкой. Проверьте дочернюю сессию и отправьте /retry в этом чате.";
  }
  return "Рабочая сессия остановилась из-за технической ошибки. Отправьте /retry в этом чате.";
}
