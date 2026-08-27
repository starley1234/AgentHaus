import { useQuery } from "@tanstack/react-query";

export const AUTOMATION_GUARD_QUERY_KEY = ["automation-guard"] as const;

export interface AutomationGuard {
  allow_create: boolean;
}

/**
 * Read the automation-creation guard state exposed by the static-server proxy
 * (`GET /api/automation-guard`). When `allow_create` is false (env
 * `AUTOMATION_ALLOW_CREATE=0`), POSTs that create automations are rejected
 * with 403 server-side; the UI shows a banner and disables the create/import
 * buttons. Endpoint is served by the local proxy only — treat absence
 * (e.g. dev-server without the proxy) as "allowed".
 */
export function useAutomationGuard() {
  return useQuery<AutomationGuard>({
    queryKey: AUTOMATION_GUARD_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/automation-guard");
      if (!res.ok) return { allow_create: true };
      return (await res.json()) as AutomationGuard;
    },
    staleTime: 60 * 1000,
    retry: false,
  });
}
