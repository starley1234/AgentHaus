import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCanvasUpdateCard } from "./agent-canvas-update-card";

const { getLockedCloudHostMock } = vi.hoisted(() => ({
  getLockedCloudHostMock: vi.fn(),
}));

vi.mock("#/api/agent-server-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/agent-server-config")>()),
  getLockedCloudHost: getLockedCloudHostMock,
}));

function renderCard() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentCanvasUpdateCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getLockedCloudHostMock.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentCanvasUpdateCard", () => {
  it("renders nothing (the update card is hidden for the personal fork)", () => {
    renderCard();
    expect(
      screen.queryByTestId("agent-canvas-update-card"),
    ).not.toBeInTheDocument();
  });
});
