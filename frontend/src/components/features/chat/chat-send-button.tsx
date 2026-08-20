import { ArrowUp } from "lucide-react";
import { cn } from "#/utils/utils";

export interface ChatSendButtonProps {
  buttonClassName: string;
  handleSubmit: () => void;
  disabled: boolean;
}

export function ChatSendButton({
  buttonClassName,
  handleSubmit,
  disabled,
}: ChatSendButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center justify-center rounded-full border size-8 border-[var(--oh-border)] text-[var(--oh-foreground)]",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-[var(--oh-interactive-hover)]",
        buttonClassName,
      )}
      data-name="arrow-up-circle-fill"
      data-testid="submit-button"
      onClick={handleSubmit}
      disabled={disabled}
    >
      <ArrowUp className="w-4 h-4" color="currentColor" />
    </button>
  );
}
