import path from "path";

const exeBasename = path.basename(process.argv[0] || "gdx")
export const EXECUTABLE_NAME = exeBasename.startsWith("bun") ? "gdx" : exeBasename;
