import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { installAdviser } from "./adviser.ts";
import { loadOmpSources } from "./context.ts";

export default function compactAdviser(pi: ExtensionAPI): void {
  const omp = CONFIG_DIR_NAME === ".omp";
  installAdviser(pi, {
    agentDir: getAgentDir(),
    version: VERSION,
    host: omp ? "omp" : "pi",
    ...(omp ? { sources: loadOmpSources } : {}),
  });
}
