import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { installAdviser } from "./adviser.ts";

export default function compactAdviser(pi: ExtensionAPI): void {
  installAdviser(pi, {
    agentDir: getAgentDir(),
    version: VERSION,
    host: CONFIG_DIR_NAME === ".omp" ? "omp" : "pi",
  });
}
