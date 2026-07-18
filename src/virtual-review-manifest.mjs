import crypto from "node:crypto";

const maximumManifestBytes = 1024 * 1024;
const maximumVirtualCommits = 100;
const maximumTextLength = 16 * 1024;

export class ManifestValidationError extends Error {
    constructor(details) {
        super("Virtual review manifest is invalid");
        this.name = "ManifestValidationError";
        this.code = "INVALID_MANIFEST";
        this.details = details;
    }
}

const addError = (errors, code, path, message, extra = {}) => {
    errors.push({ code, path, message, ...extra });
};

const requiredText = (value, path, errors, { maximum = maximumTextLength } = {}) => {
    if (typeof value !== "string" || value.trim().length === 0) {
        addError(errors, "REQUIRED_TEXT", path, "Expected a non-empty string");
        return "";
    }
    if (value.length > maximum) {
        addError(errors, "TEXT_TOO_LONG", path, `Text must not exceed ${maximum} characters`);
    }
    return value.trim();
};

const targetValue = (target, validBlocks, validFiles) => {
    if (typeof target !== "string") return false;
    if (target.startsWith("block:")) return validBlocks.has(target.slice("block:".length));
    if (target.startsWith("file:")) return validFiles.has(target.slice("file:".length));
    return false;
};

const validateTargets = ({ value, path, errors, validBlocks, validFiles, allowEmpty = false }) => {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
        addError(errors, "INVALID_TARGETS", path, allowEmpty
            ? "Expected an array of targets"
            : "Expected at least one block:<id> or file:<path> target");
        return [];
    }
    const targets = [];
    value.forEach((target, index) => {
        if (!targetValue(target, validBlocks, validFiles)) {
            addError(errors, "UNKNOWN_TARGET", `${path}[${index}]`, "Target does not exist in the source snapshot", { target });
            return;
        }
        targets.push(target);
    });
    return [...new Set(targets)];
};

const validateGuidance = ({ value, path, errors, validBlocks, validFiles }) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
        addError(errors, "INVALID_REVIEW_FOCUS", path, "Expected 1 to 3 review focus items");
        return [];
    }
    return value.map((item, index) => ({
        text: requiredText(item?.text, `${path}[${index}].text`, errors, { maximum: 2048 }),
        targets: validateTargets({
            value: item?.targets,
            path: `${path}[${index}].targets`,
            errors,
            validBlocks,
            validFiles,
        }),
    }));
};

const validateUncertainties = ({ value, path, errors, validBlocks, validFiles }) => {
    if (!Array.isArray(value)) {
        addError(errors, "INVALID_UNCERTAINTIES", path, "Expected an array, which may be empty");
        return [];
    }
    if (value.length > 100) addError(errors, "TOO_MANY_UNCERTAINTIES", path, "At most 100 uncertainties are allowed");
    return value.slice(0, 100).map((item, index) => ({
        text: requiredText(item?.text, `${path}[${index}].text`, errors, { maximum: 2048 }),
        targets: validateTargets({
            value: item?.targets,
            path: `${path}[${index}].targets`,
            errors,
            validBlocks,
            validFiles,
        }),
    }));
};

export const validateVirtualReviewManifest = ({ source, manifest }) => {
    const errors = [];
    let encoded;
    try {
        encoded = JSON.stringify(manifest);
    } catch {
        throw new ManifestValidationError([{
            code: "INVALID_JSON_VALUE",
            path: "$",
            message: "Manifest must be JSON serializable",
        }]);
    }
    if (Buffer.byteLength(encoded) > maximumManifestBytes) {
        addError(errors, "MANIFEST_TOO_LARGE", "$", `Manifest must not exceed ${maximumManifestBytes} bytes`);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new ManifestValidationError([{
            code: "INVALID_MANIFEST_ROOT",
            path: "$",
            message: "Manifest must be a JSON object",
        }]);
    }
    if (manifest.schemaVersion !== 1) {
        addError(errors, "UNSUPPORTED_SCHEMA", "schemaVersion", "Only schemaVersion 1 is supported");
    }

    const validBlocks = new Set(source.files.flatMap((file) => file.blocks.map((block) => block.id)));
    const validFiles = new Set(source.files.flatMap((file) => [file.oldPath, file.newPath].filter(Boolean)));
    const title = requiredText(manifest.title, "title", errors, { maximum: 512 });
    const strategy = requiredText(manifest.strategy, "strategy", errors, { maximum: 4096 });
    const overview = {
        summary: requiredText(manifest.overview?.summary, "overview.summary", errors),
        routeRationale: requiredText(manifest.overview?.routeRationale, "overview.routeRationale", errors),
        uncertainties: validateUncertainties({
            value: manifest.overview?.uncertainties,
            path: "overview.uncertainties",
            errors,
            validBlocks,
            validFiles,
        }),
    };

    if (!Array.isArray(manifest.virtualCommits) || manifest.virtualCommits.length === 0) {
        addError(errors, "NO_VIRTUAL_COMMITS", "virtualCommits", "At least one virtual commit is required");
    }
    if (manifest.virtualCommits?.length > maximumVirtualCommits) {
        addError(errors, "TOO_MANY_VIRTUAL_COMMITS", "virtualCommits", `At most ${maximumVirtualCommits} virtual commits are allowed`);
    }

    const assigned = new Map();
    const virtualCommits = (Array.isArray(manifest.virtualCommits) ? manifest.virtualCommits : [])
        .slice(0, maximumVirtualCommits)
        .map((commit, commitIndex) => {
            const commitPath = `virtualCommits[${commitIndex}]`;
            const blocks = [];
            if (!Array.isArray(commit?.blocks) || commit.blocks.length === 0) {
                addError(errors, "EMPTY_VIRTUAL_COMMIT", `${commitPath}.blocks`, "Every virtual commit must contain at least one block");
            } else {
                commit.blocks.forEach((blockId, blockIndex) => {
                    const blockPath = `${commitPath}.blocks[${blockIndex}]`;
                    if (typeof blockId !== "string" || !validBlocks.has(blockId)) {
                        addError(errors, "UNKNOWN_BLOCK", blockPath, "Block does not exist in the source snapshot", { blockId });
                        return;
                    }
                    if (assigned.has(blockId)) {
                        addError(errors, "DUPLICATE_BLOCK", blockPath, "Block is assigned more than once", {
                            blockId,
                            firstPath: assigned.get(blockId),
                        });
                        return;
                    }
                    assigned.set(blockId, blockPath);
                    blocks.push(blockId);
                });
            }
            const riskLevel = commit?.risk?.level;
            if (!new Set(["low", "medium", "high", "critical"]).has(riskLevel)) {
                addError(errors, "INVALID_RISK", `${commitPath}.risk.level`, "Risk must be low, medium, high, or critical");
            }
            const id = crypto.createHash("sha256")
                .update(source.sourceId)
                .update("\0")
                .update(String(commitIndex))
                .update("\0")
                .update(blocks.join("\0"))
                .digest("hex")
                .slice(0, 24);
            return {
                id,
                title: requiredText(commit?.title, `${commitPath}.title`, errors, { maximum: 512 }),
                intent: requiredText(commit?.intent, `${commitPath}.intent`, errors, { maximum: 4096 }),
                reviewFocus: validateGuidance({
                    value: commit?.reviewFocus,
                    path: `${commitPath}.reviewFocus`,
                    errors,
                    validBlocks,
                    validFiles,
                }),
                risk: {
                    level: riskLevel,
                    reason: requiredText(commit?.risk?.reason, `${commitPath}.risk.reason`, errors, { maximum: 2048 }),
                },
                blocks,
            };
        });

    const missingBlocks = [...validBlocks].filter((blockId) => !assigned.has(blockId));
    missingBlocks.forEach((blockId) => addError(
        errors,
        "MISSING_BLOCK",
        "virtualCommits",
        "Source block is not assigned to any virtual commit",
        { blockId },
    ));
    if (errors.length > 0) throw new ManifestValidationError(errors);

    return {
        schemaVersion: 1,
        title,
        strategy,
        overview,
        virtualCommits,
    };
};
