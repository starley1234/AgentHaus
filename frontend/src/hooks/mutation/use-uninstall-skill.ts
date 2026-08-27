import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import SkillsManagementService from "#/api/skills-management-service";
import { SKILLS_QUERY_KEYS } from "#/hooks/query/query-keys";
import { I18nKey } from "#/i18n/declaration";
import { displaySuccessToast } from "#/utils/custom-toast-handlers";

/**
 * Uninstall a skill. On success the installed list and the skills catalog
 * are invalidated so the UI updates.
 */
export function useUninstallSkill() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("openhands");

  return useMutation({
    mutationFn: (name: string) => SkillsManagementService.uninstallSkill(name),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: SKILLS_QUERY_KEYS.all,
      });
      queryClient.invalidateQueries({
        queryKey: SKILLS_QUERY_KEYS.installed,
      });
      displaySuccessToast(t(I18nKey.SETTINGS$SKILLS_UNINSTALL_SUCCESS));
    },
  });
}
