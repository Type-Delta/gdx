/**
 * Converts a path string to use Unix-style forward slashes.
 * @param pathStr - The path string to convert.
 * @returns The path string with Unix-style forward slashes.
 */
export function asUnixPath(pathStr: string): string {
   return pathStr.replace(/\\/g, '/');
}
