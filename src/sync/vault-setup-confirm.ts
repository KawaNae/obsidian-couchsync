/**
 * vault-setup-confirm.ts — what the confirm dialog of vault Init and Clone
 * tells the user before the destructive half runs.
 *
 * The dialog comes at the end of the preparation (`VaultBinding`), so what
 * it says was read from the server just before, and a run the preparation
 * refuses never asks. The text names the database, never the server: the
 * URI can carry credentials and the host name says nothing about what is
 * destroyed.
 */

/** What Init or Clone is about to do, as the preparation found it. */
export type VaultSetupPlan =
    | {
        op: "init";
        dbName: string;
        /** `doc_count` of the server's vault DB, or null when it does not
         *  exist yet. */
        docCount: number | null;
        /** The codec of the vault Init builds (the Step 1 settings). */
        encryption: boolean;
        compression: boolean;
    }
    | {
        op: "clone";
        dbName: string;
        /** `doc_count` of the server's vault DB. */
        docCount: number;
        /** The codec of the vault on the server (its `vault:meta`). */
        encryption: boolean;
        compression: boolean;
    };

export interface VaultSetupConfirm {
    title: string;
    message: string;
    confirmText: string;
}

function describeCodec(p: { encryption: boolean; compression: boolean }): string {
    return `encryption ${p.encryption ? "on" : "off"}, compression ${p.compression ? "on" : "off"}`;
}

function docs(n: number): string {
    return `${n.toLocaleString()} document${n === 1 ? "" : "s"}`;
}

/** The dialog text for `plan`. Paragraphs are separated by a blank line. */
export function describeVaultSetupConfirm(plan: VaultSetupPlan): VaultSetupConfirm {
    const db = `"${plan.dbName}"`;
    if (plan.op === "init") {
        const server = plan.docCount === null
            ? "On the server now: the database does not exist yet. Init creates it."
            : plan.docCount === 0
                ? "On the server now: no documents."
                : `On the server now: ${docs(plan.docCount)}. All of them will be deleted.`;
        return {
            title: `Init vault database ${db}?`,
            confirmText: "Init",
            message: [
                `Init deletes the vault database ${db} on the server and creates it ` +
                    `again from the files in this vault (${describeCodec(plan)} — the ` +
                    "Step 1 settings). This cannot be undone.",
                server,
                `Every other device that uses ${db} must Clone again (Step 3). A device ` +
                    "that notices the re-created database stops its live sync until then.",
                "On this device the local vault database is rebuilt from the vault " +
                    "files; the files themselves are not changed.",
            ].join("\n\n"),
        };
    }
    return {
        title: `Clone vault database ${db}?`,
        confirmText: "Clone",
        message: [
            "Clone deletes the local vault database of this device and fills it " +
                `again from ${db} on the server (${docs(plan.docCount)}, ` +
                `${describeCodec(plan)}).`,
            "Then it writes the server's files into this vault: a file at the same " +
                "path is replaced with the server's version, and a file deleted on " +
                "the server is deleted here. Files the server does not have are kept.",
            "The database on the server is not changed.",
        ].join("\n\n"),
    };
}
