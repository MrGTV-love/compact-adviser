// Pure helpers that only the omp host ships; see loadOmpSources in context.ts.
declare module "@oh-my-pi/pi-natives" {
  export function editInspect(mode: "hashline", argsJson: string): { paths: string[] };
}
declare module "@oh-my-pi/pi-utils/ar" {
  export function parseArchivePathCandidates(
    filePath: string,
  ): { archivePath: string; subPath: string }[];
}
