export function minimatch(filePath: string, pattern: string): boolean {
    const regex = globToRegex(pattern);
    return regex.test(filePath);
}

function globToRegex(glob: string): RegExp {
    let regex = "";
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                if (glob[i + 2] === "/") {
                    regex += "(?:.+/)?";
                    i += 3;
                    continue;
                }
                regex += ".*";
                i += 2;
                continue;
            }
            regex += "[^/]*";
        } else if (c === "?") {
            regex += "[^/]";
        } else if (c === ".") {
            regex += "\\.";
        } else {
            regex += c;
        }
        i++;
    }
    return new RegExp(`^${regex}$`);
}
