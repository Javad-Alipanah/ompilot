import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** GUI extension hosts do not always inherit an interactive shell's PATH. */
export function resolveOmpPath(configured = "omp"): string {
  if (configured !== "omp") return configured;
  const executable = process.platform === "win32" ? "omp.exe" : "omp";
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, executable)),
    path.join(os.homedir(), ".bun", "bin", executable),
    path.join(os.homedir(), ".local", "bin", executable),
    path.join(os.homedir(), ".omp", "bin", executable),
  ];
  return (
    candidates.find((candidate) => {
      try {
        fs.accessSync(
          candidate,
          process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        );
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? configured
  );
}
