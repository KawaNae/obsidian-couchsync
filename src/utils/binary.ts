const BINARY_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico",
    "mp3", "wav", "ogg", "m4a", "flac",
    "mp4", "webm", "ogv",
    "pdf", "zip", "tar", "gz",
    "wasm", "node",
    "woff", "woff2", "ttf", "otf", "eot",
    "pack",
]);

export function isBinaryFile(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return BINARY_EXTENSIONS.has(ext);
}
