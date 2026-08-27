import { SkillsClient } from "@openhands/typescript-client/clients";
import { getActiveBackend } from "./backend-registry/active-store";
import { getAgentServerClientOptions } from "./agent-server-client-options";

export interface InstalledSkillInfo {
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  source: string;
  resolved_ref?: string | null;
  repo_path?: string | null;
  installed_at: string;
  install_path: string;
}

interface SkillsManagementClient {
  listInstalledSkills(): Promise<{ skills: InstalledSkillInfo[] }>;
  installSkill(request: {
    source: string;
    ref?: string | null;
    repo_path?: string | null;
    force?: boolean;
  }): Promise<InstalledSkillInfo>;
  setSkillEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean }>;
  uninstallSkill(name: string): Promise<{ message: string }>;
  refreshSkill(
    name: string,
  ): Promise<{ message: string; skill: InstalledSkillInfo }>;
}

function isCloudBackend(): boolean {
  return getActiveBackend().backend.kind === "cloud";
}

function getManagementClient(): SkillsManagementClient {
  return new SkillsClient(
    getAgentServerClientOptions(),
  ) as unknown as SkillsManagementClient;
}

class SkillsManagementService {
  static async listInstalledSkills(): Promise<InstalledSkillInfo[]> {
    if (isCloudBackend()) return [];
    try {
      const response = await getManagementClient().listInstalledSkills();
      return response.skills ?? [];
    } catch {
      return [];
    }
  }

  static async uninstallSkill(name: string): Promise<{ message: string }> {
    if (isCloudBackend()) {
      throw new Error("Uninstalling skills is only available on a local backend.");
    }
    return getManagementClient().uninstallSkill(name);
  }

  static async refreshSkill(
    name: string,
  ): Promise<{ message: string; skill: InstalledSkillInfo }> {
    if (isCloudBackend()) {
      throw new Error("Refreshing skills is only available on a local backend.");
    }
    return getManagementClient().refreshSkill(name);
  }

  static async setSkillEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean }> {
    if (isCloudBackend()) {
      throw new Error("Enabling/disabling skills is only available on a local backend.");
    }
    return getManagementClient().setSkillEnabled(name, enabled);
  }
}

export default SkillsManagementService;
