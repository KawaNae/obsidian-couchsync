const regexCache = new Map<string, RegExp>();

export function minimatch(filePath: string, pattern: string): boolean {
    let regex = regexCache.get(pattern);
    if (!regex) {
        regex = globToRegex(pattern);
        regexCache.set(pattern, regex);
    }
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
        } else if ("\\^$.|+()[]{}".includes(c)) {
            regex += "\\" + c;
        } else {
            regex += c;
        }
        i++;
    }
    return new RegExp(`^${regex}$`);
}
