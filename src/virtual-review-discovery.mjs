import fs from "node:fs/promises";
import path from "node:path";

import {
    listVirtualReviews,
    loadVirtualSource,
    virtualReviewStateRoot,
} from "./virtual-review-store.mjs";

const shortSha = (sha) => typeof sha === "string" ? sha.slice(0, 8) : "";

const currentBoundaryFor = ({ baseSha, headSha, targetSha }) => ({
    baseSha,
    headSha,
    targetSha,
});

const sourceBoundaryFor = (source) => ({
    baseSha: source?.repository?.baseSha || "",
    headSha: source?.repository?.headSha
        || source?.endpoints?.to?.sha
        || source?.branchCommit?.sha
        || "",
    targetSha: source?.repository?.targetSha || "",
});

const boundariesMatch = (source, current) => (
    ["baseSha", "headSha", "targetSha"].every((name) => (
        typeof source[name] === "string"
        && source[name].length > 0
        && source[name] === current[name]
    ))
);

const canonicalInputRoot = async (value) => {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("Virtual review discovery requires a repository root");
    }
    return fs.realpath(path.resolve(value));
};

const canonicalStoredRoot = async (value, cache) => {
    if (typeof value !== "string" || !path.isAbsolute(value)) return null;
    const resolved = path.resolve(value);
    if (!cache.has(resolved)) {
        cache.set(resolved, fs.realpath(resolved).catch(() => null));
    }
    return cache.get(resolved);
};

const timestamp = (value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const compareCandidates = (left, right) => {
    if (left.state !== right.state) return left.state === "current" ? -1 : 1;
    const dateDifference = timestamp(right.createdAt) - timestamp(left.createdAt);
    if (dateDifference !== 0) return dateDifference;
    if (left.revision !== right.revision) return right.revision - left.revision;
    return left.reviewId.localeCompare(right.reviewId);
};

/**
 * Find the best saved Virtual Review revision for one live Local MR identity.
 *
 * Repository, branch, and target-ref identity are intentionally stricter than
 * freshness. A moved HEAD/base/target keeps the saved review discoverable but
 * marks it stale; it never permits a review from another branch or target.
 */
export const discoverVirtualReview = async ({
    repoRoot,
    repositoryRoot,
    branchName,
    targetRef,
    baseSha,
    headSha,
    targetSha,
    stateRoot = virtualReviewStateRoot(),
}) => {
    if (typeof branchName !== "string" || branchName.length === 0) {
        throw new TypeError("Virtual review discovery requires a branch name");
    }
    if (typeof targetRef !== "string" || targetRef.length === 0) {
        throw new TypeError("Virtual review discovery requires a target ref");
    }
    const currentBoundary = currentBoundaryFor({ baseSha, headSha, targetSha });
    if (Object.values(currentBoundary).some((sha) => typeof sha !== "string" || sha.length === 0)) {
        throw new TypeError("Virtual review discovery requires current base, head, and target SHAs");
    }

    const canonicalRoot = await canonicalInputRoot(repoRoot ?? repositoryRoot);
    const storedRootCache = new Map();
    const candidates = [];
    const reviews = await listVirtualReviews(stateRoot);

    for (const review of reviews) {
        if (typeof review?.reviewId !== "string" || !Array.isArray(review.revisions)) continue;
        for (const revision of review.revisions) {
            if (
                !Number.isSafeInteger(revision?.revision)
                || revision.revision < 1
                || typeof revision.sourceId !== "string"
                || typeof revision.createdAt !== "string"
                || !Number.isFinite(Date.parse(revision.createdAt))
                || typeof revision.title !== "string"
            ) continue;
            try {
                const source = await loadVirtualSource(revision.sourceId, stateRoot);
                const repository = source?.repository;
                if (
                    !repository
                    || repository.branchName !== branchName
                    || repository.targetRef !== targetRef
                    || await canonicalStoredRoot(repository.root, storedRootCache) !== canonicalRoot
                ) continue;

                const sourceBoundary = sourceBoundaryFor(source);
                const sourceSha = sourceBoundary.headSha;
                candidates.push({
                    reviewId: review.reviewId,
                    revision: revision.revision,
                    sourceId: revision.sourceId,
                    state: boundariesMatch(sourceBoundary, currentBoundary) ? "current" : "stale",
                    sourceSha,
                    sourceShortSha: shortSha(sourceSha),
                    currentSha: headSha,
                    currentShortSha: shortSha(headSha),
                    sourceBoundary,
                    currentBoundary: { ...currentBoundary },
                    createdAt: revision.createdAt,
                    title: revision.title,
                });
            } catch {
                // One missing or corrupt immutable source must not hide other reviews.
            }
        }
    }

    candidates.sort(compareCandidates);
    return candidates[0] || null;
};
