import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

export const localMr = path.join(projectRoot, "bin", "local-mr");
