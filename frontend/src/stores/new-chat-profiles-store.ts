import { create } from "zustand";
import { devtools } from "zustand/middleware";

/**
 * Профили, выбранные на главной странице для СЛЕДУЮЩЕГО нового чата.
 *
 * Когда пользователь на стартовой странице выбирает агент-профиль и/или
 * LLM-профиль, выбор здесь запоминается (а НЕ активируется глобально и НЕ
 * создаёт чат сразу). При отправке первого сообщения HomeChatLauncher
 * применяет их к создаваемому чату (per-chat), затем очищает.
 *
 * Это аддитивно: отдельный стор, ядро не трогает.
 */
interface NewChatProfilesState {
  /** ID выбранного агент-профиля (или null). */
  agentProfileId: string | null;
  /** Имя выбранного LLM-профиля (или null). */
  llmProfileName: string | null;
  /** Текст, который надо подставить в поле ввода на главной (например из «Типы задач»). */
  pendingPrompt: string | null;
  setAgentProfileId: (id: string | null) => void;
  setLlmProfileName: (name: string | null) => void;
  setPendingPrompt: (text: string | null) => void;
  clear: () => void;
}

export const useNewChatProfilesStore = create<NewChatProfilesState>()(
  devtools(
    (set) => ({
      agentProfileId: null,
      llmProfileName: null,
      pendingPrompt: null,
      setAgentProfileId: (agentProfileId) => set({ agentProfileId }),
      setLlmProfileName: (llmProfileName) => set({ llmProfileName }),
      setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),
      clear: () =>
        set({ agentProfileId: null, llmProfileName: null, pendingPrompt: null }),
    }),
    { name: "new-chat-profiles" },
  ),
);
