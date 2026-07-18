export const demoReviewSource = Object.freeze({
    repositoryUrl: "https://github.com/Ne9roni/local-mr",
    commitUrl: "https://github.com/Ne9roni/local-mr/commit/5d009fbc8571353641029b98a5ff166948dcb311",
    commitLabel: "Virtual Commit feature commit",
    baseSha: "e524ea042bf9bf092363e6851fa2ed8507643256",
    headSha: "5d009fbc8571353641029b98a5ff166948dcb311",
    branchName: "main",
    targetRef: "e524ea0 (initial commit)",
    reviewId: "local-mr-virtual-commit-feature",
});

const filePaths = (file) => [file.oldPath, file.newPath].filter(Boolean);
const hasPath = (file, predicate) => filePaths(file).some(predicate);
const exact = (...paths) => (file) => hasPath(file, (candidate) => paths.includes(candidate));
const below = (...directories) => (file) => hasPath(
    file,
    (candidate) => directories.some((directory) => candidate.startsWith(`${directory}/`)),
);
const either = (...predicates) => (file) => predicates.some((predicate) => predicate(file));

const documentation = exact(
    "README.md",
    "README.zh-CN.md",
    "docs/architecture.md",
    "docs/virtual-commits.md",
    "docs/zh-CN/README.md",
    "docs/zh-CN/architecture.md",
    "docs/zh-CN/virtual-commits.md",
);

const publicContract = either(
    exact(
        "bin/local-mr",
        "scripts/install.sh",
        "src/virtual-review-cli.mjs",
        "src/virtual-review-manifest.mjs",
    ),
    below("skills"),
);

const releaseMetadata = exact(
    "CHANGELOG.md",
    "docs/zh-CN/CHANGELOG.md",
    "package.json",
);

const overviewGroupDefinitions = [
    {
        key: "read-the-contract",
        title: "Read the contract before the implementation",
        intent: "Start with the human-facing explanation of why Virtual Commits exist, how reviewers use them, and which invariants the implementation must preserve.",
        matches: documentation,
        reviewFocus: [
            {
                text: "Extract the source-freezing, block-conservation, and final-tree guarantees before reading their implementation.",
                targets: ["file:docs/virtual-commits.md", "file:docs/architecture.md"],
            },
            {
                text: "Check that the concise README workflow agrees with the detailed guide.",
                targets: ["file:README.md"],
            },
        ],
        risk: {
            level: "medium",
            reason: "The documentation defines the reviewer's mental model and must not promise guarantees the code does not enforce.",
        },
    },
    {
        key: "map-the-public-contract",
        title: "Map the CLI and agent contract",
        intent: "Follow the user and agent entry points from source capture through manifest submission and structured validation.",
        matches: publicContract,
        reviewFocus: [
            {
                text: "Trace manifest input from the CLI boundary through schema and block-assignment validation.",
                targets: ["file:src/virtual-review-cli.mjs", "file:src/virtual-review-manifest.mjs"],
            },
            {
                text: "Confirm the bundled Skill describes the same protocol and safety boundary enforced by the CLI.",
                targets: ["file:skills/local-mr-virtual-commits/SKILL.md"],
            },
        ],
        risk: {
            level: "high",
            reason: "This contract decides which frozen source an agent may reorganize and which invalid plans are rejected.",
        },
    },
    {
        key: "verify-the-core",
        title: "Verify freezing, materialization, and storage",
        intent: "Review the deterministic core that freezes the real Diff, assigns every change block once, materializes cumulative states, and stores immutable revisions.",
        matches: exact(
            "src/version-model.mjs",
            "src/virtual-diff.mjs",
            "src/virtual-review-core.mjs",
            "src/virtual-review-store.mjs",
        ),
        reviewFocus: [
            {
                text: "Check merge-base selection and stable block identities across every supported change kind.",
                targets: ["file:src/version-model.mjs", "file:src/virtual-diff.mjs"],
            },
            {
                text: "Verify exact block conservation, final-tree equality, atomic persistence, and private file permissions.",
                targets: ["file:src/virtual-review-core.mjs", "file:src/virtual-review-store.mjs"],
            },
        ],
        risk: {
            level: "critical",
            reason: "A flaw here could omit code, compare the wrong source, or make a supposedly immutable review revision drift.",
        },
    },
    {
        key: "follow-the-review-runtime",
        title: "Follow the review runtime into the browser",
        intent: "Connect saved revisions to Real and Virtual navigation, Diff rendering, context expansion, previews, and browser state.",
        matches: exact(
            "src/review-ui.html",
            "src/version-server.mjs",
            "src/virtual-review-discovery.mjs",
            "src/virtual-review-runtime.mjs",
            "src/virtual-review-server.mjs",
        ),
        reviewFocus: [
            {
                text: "Follow one frozen revision through discovery, runtime identity checks, server responses, and browser restoration.",
                targets: ["file:src/virtual-review-runtime.mjs", "file:src/virtual-review-server.mjs"],
            },
            {
                text: "Confirm Real and Virtual selections use the shared workspace without displaying stale comparison data.",
                targets: ["file:src/version-server.mjs", "file:src/review-ui.html"],
            },
        ],
        risk: {
            level: "high",
            reason: "Correct stored data is still unsafe to review if the browser presents a stale or mismatched comparison.",
        },
    },
    {
        key: "challenge-it-with-tests",
        title: "Challenge the guarantees with tests",
        intent: "Match the implementation's safety claims to adversarial unit, integration, installation, and browser regressions.",
        matches: either(below("test"), exact("scripts/test-browser.mjs")),
        reviewFocus: [
            {
                text: "Look for missing and duplicate blocks, repository drift, target merges, binary changes, renames, and concurrent revisions.",
                targets: ["file:test/virtual-review-regression.mjs", "file:test/version-model.test.mjs"],
            },
            {
                text: "Confirm browser coverage exercises source switching and context expansion rather than only static markup.",
                targets: ["file:test/virtual-review-ui-regression.mjs", "file:scripts/test-browser.mjs"],
            },
        ],
        risk: {
            level: "medium",
            reason: "The tests are the executable evidence that reordering changes presentation rather than content.",
        },
    },
    {
        key: "finish-with-release-metadata",
        title: "Finish with release metadata",
        intent: "Review package wiring and change notes after the implementation and its evidence are understood.",
        matches: releaseMetadata,
        reviewFocus: [
            {
                text: "Check that package entry points and scripts expose the documented workflow.",
                targets: ["file:package.json"],
            },
            {
                text: "Confirm both change logs describe the same shipped capability without overstating it.",
                targets: ["file:CHANGELOG.md", "file:docs/zh-CN/CHANGELOG.md"],
            },
        ],
        risk: {
            level: "low",
            reason: "These files do not implement the feature, but stale packaging or release notes can make the shipped interface diverge from the reviewed code.",
        },
    },
];

const deepReviewGroupDefinitions = [
    overviewGroupDefinitions[0],
    overviewGroupDefinitions[1],
    {
        key: "freeze-stable-blocks",
        title: "Freeze the source and define stable change blocks",
        intent: "Verify merge-base selection and the deterministic block model before any change is reordered into a Virtual Commit.",
        matches: exact("src/version-model.mjs", "src/virtual-diff.mjs"),
        reviewFocus: [
            {
                text: "Check that target-only history cannot leak into the frozen review range.",
                targets: ["file:src/version-model.mjs"],
            },
            {
                text: "Verify stable identities for text, binary, rename, delete, and submodule changes.",
                targets: ["file:src/virtual-diff.mjs"],
            },
        ],
        risk: {
            level: "critical",
            reason: "Every later conservation guarantee depends on freezing the right Diff and naming each block exactly once.",
        },
    },
    {
        key: "materialize-the-target",
        title: "Reconstruct the exact target tree",
        intent: "Follow cumulative block application from the frozen base through every Virtual state to the real feature commit tree.",
        matches: exact("src/virtual-review-core.mjs"),
        reviewFocus: [
            {
                text: "Verify missing, duplicate, unknown, or malformed block assignments fail closed.",
                targets: ["file:src/virtual-review-core.mjs"],
            },
            {
                text: "Confirm final-tree equality is checked after materialization rather than inferred from block counts.",
                targets: ["file:src/virtual-review-core.mjs"],
            },
        ],
        risk: {
            level: "critical",
            reason: "A flaw here could silently omit or alter code while presenting a plausible review route.",
        },
    },
    {
        key: "protect-review-history",
        title: "Protect immutable review history",
        intent: "Audit revision storage, locking, atomic writes, permissions, progress, and cleanup.",
        matches: exact("src/virtual-review-store.mjs"),
        reviewFocus: [
            {
                text: "Check concurrent revision creation and recovery from interrupted writes.",
                targets: ["file:src/virtual-review-store.mjs"],
            },
            {
                text: "Confirm permissions and cleanup match a private-source-code storage boundary.",
                targets: ["file:src/virtual-review-store.mjs"],
            },
        ],
        risk: {
            level: "high",
            reason: "Mutable or weakly protected snapshots would undermine reproducibility and source confidentiality.",
        },
    },
    {
        key: "discover-saved-reviews",
        title: "Discover the right saved review",
        intent: "Verify that the default command attaches the newest compatible revision to the current repository comparison.",
        matches: exact("src/virtual-review-discovery.mjs"),
        reviewFocus: [
            {
                text: "Check repository, target, base, and head matching before a saved revision is attached.",
                targets: ["file:src/virtual-review-discovery.mjs"],
            },
            {
                text: "Confirm stale revisions remain visible without being mistaken for the current source.",
                targets: ["file:src/virtual-review-discovery.mjs"],
            },
        ],
        risk: {
            level: "high",
            reason: "Choosing the wrong saved review can put valid Virtual Commit labels over unrelated source code.",
        },
    },
    {
        key: "pin-runtime-identity",
        title: "Pin runtime identity and source handoff",
        intent: "Follow a stored revision into its runtime while keeping repository, source, and revision identity immutable.",
        matches: exact("src/virtual-review-runtime.mjs"),
        reviewFocus: [
            {
                text: "Confirm opening a stored review cannot silently fall back to live HEAD or another repository.",
                targets: ["file:src/virtual-review-runtime.mjs"],
            },
            {
                text: "Check stale-source reporting without mutating the frozen source.",
                targets: ["file:src/virtual-review-runtime.mjs"],
            },
        ],
        risk: {
            level: "critical",
            reason: "An identity mix-up could show valid code from the wrong source while retaining a trusted review URL.",
        },
    },
    {
        key: "serve-virtual-comparisons",
        title: "Serve Virtual comparisons and context",
        intent: "Audit selection parsing, tree-to-tree comparison, context expansion, previews, and Real or Virtual navigation.",
        matches: exact("src/virtual-review-server.mjs"),
        reviewFocus: [
            {
                text: "Verify every selection resolves to the intended before and after Virtual states.",
                targets: ["file:src/virtual-review-server.mjs"],
            },
            {
                text: "Check that context, previews, IDs, paths, and revisions remain scoped to the frozen source.",
                targets: ["file:src/virtual-review-server.mjs"],
            },
        ],
        risk: {
            level: "critical",
            reason: "This boundary turns stored state into reviewer-visible code and handles untrusted URL input.",
        },
    },
    {
        key: "integrate-the-shared-server",
        title: "Integrate Virtual history into the shared server",
        intent: "Verify discovery, source attachment, routes, and version metadata remain consistent in the normal Local MR server.",
        matches: exact("src/version-server.mjs"),
        reviewFocus: [
            {
                text: "Trace how the default Local MR page discovers and attaches a compatible Virtual review.",
                targets: ["file:src/version-server.mjs"],
            },
            {
                text: "Check route and cache identity when switching between Real and Virtual sources.",
                targets: ["file:src/version-server.mjs"],
            },
        ],
        risk: {
            level: "high",
            reason: "A bad handoff can make the normal review page display metadata or Diff content from another comparison.",
        },
    },
    {
        key: "navigate-the-workspace",
        title: "Navigate the shared review workspace",
        intent: "Read the browser state machine for modes, ranges, revisions, Real and Virtual switching, context, previews, and restored selections.",
        matches: exact("src/review-ui.html"),
        reviewFocus: [
            {
                text: "Follow a selection through URL state, data loading, source switching, and history restoration.",
                targets: ["file:src/review-ui.html"],
            },
            {
                text: "Check that syntax, context, previews, and controls never imply a different comparison from the Diff on screen.",
                targets: ["file:src/review-ui.html"],
            },
        ],
        risk: {
            level: "high",
            reason: "A misleading workspace can make reviewers approve the wrong comparison even when server data is correct.",
        },
    },
    {
        key: "prove-core-invariants",
        title: "Prove the core invariants with adversarial tests",
        intent: "Match source freezing, block conservation, manifest validation, and final-tree equality to executable failure cases.",
        matches: exact(
            "test/version-model.test.mjs",
            "test/virtual-diff.test.mjs",
            "test/virtual-review-manifest.test.mjs",
            "test/virtual-review-regression.mjs",
        ),
        reviewFocus: [
            {
                text: "Look for target merges, drift, missing blocks, duplicate blocks, binary data, renames, and submodules.",
                targets: ["file:test/virtual-review-regression.mjs", "file:test/version-model.test.mjs"],
            },
            {
                text: "Confirm negative tests prove fail-closed behavior rather than only friendly error text.",
                targets: ["file:test/virtual-review-manifest.test.mjs", "file:test/virtual-diff.test.mjs"],
            },
        ],
        risk: {
            level: "high",
            reason: "These tests are the executable evidence that reordering changes presentation rather than code.",
        },
    },
    {
        key: "stress-persistence-and-discovery",
        title: "Stress persistence, discovery, and installation",
        intent: "Inspect regressions for concurrent revisions, saved-review matching, frozen runtime identity, attachment, and package installation.",
        matches: exact(
            "test/install-regression.mjs",
            "test/virtual-review-attachment-regression.mjs",
            "test/virtual-review-discovery.test.mjs",
            "test/virtual-review-runtime.test.mjs",
            "test/virtual-review-store.test.mjs",
        ),
        reviewFocus: [
            {
                text: "Check concurrent writers, immutable revisions, stale repositories, and compatible review discovery.",
                targets: ["file:test/virtual-review-store.test.mjs", "file:test/virtual-review-discovery.test.mjs"],
            },
            {
                text: "Verify the installed package includes the CLI and bundled Skill needed by the documented workflow.",
                targets: ["file:test/install-regression.mjs"],
            },
        ],
        risk: {
            level: "high",
            reason: "Cross-process and installed-package failures often escape core unit tests.",
        },
    },
    {
        key: "exercise-the-complete-review",
        title: "Exercise the complete review experience",
        intent: "Finish authored behavior with the remaining integration and browser regressions for rendering, context, caching, previews, and read state.",
        matches: either(below("test"), exact("scripts/test-browser.mjs")),
        reviewFocus: [
            {
                text: "Confirm browser tests operate controls and inspect the resulting Diff rather than only static markup.",
                targets: ["file:test/virtual-review-ui-regression.mjs", "file:scripts/test-browser.mjs"],
            },
            {
                text: "Check cache, context, Markdown, read-state, and renderer regressions around the shared workspace.",
                targets: ["file:test/comparison-cache-regression.mjs", "file:test/review-render.test.mjs"],
            },
        ],
        risk: {
            level: "medium",
            reason: "This is where otherwise-correct subsystems combine into the comparison a human actually approves.",
        },
    },
    overviewGroupDefinitions[5],
];

const buildManifest = ({ source, definitions, title, strategy, summary }) => {
    const groups = definitions.map((definition) => ({ ...definition, blocks: [] }));
    source.files.forEach((file) => {
        file.blocks.forEach((block) => {
            const group = groups.find((candidate) => candidate.matches(file, block));
            if (!group) throw new Error(`Demo plan did not classify ${file.displayPath} block ${block.id}`);
            group.blocks.push(block.id);
        });
    });
    const empty = groups.filter((group) => group.blocks.length === 0);
    if (empty.length > 0) {
        throw new Error(`Demo plan contains empty Virtual Commits: ${empty.map((group) => group.key).join(", ")}`);
    }

    const changedPaths = new Set(source.files.flatMap(filePaths));
    const missingTargets = groups.flatMap((group) => group.reviewFocus.flatMap((focus) => (
        focus.targets
            .filter((target) => target.startsWith("file:"))
            .map((target) => target.slice("file:".length))
            .filter((target) => !changedPaths.has(target))
            .map((target) => `${group.key}:${target}`)
    )));
    if (missingTargets.length > 0) {
        throw new Error(`Demo plan targets files outside the feature Diff: ${missingTargets.join(", ")}`);
    }

    return {
        schemaVersion: 1,
        title,
        strategy,
        overview: {
            summary,
            routeRationale: "Humans usually need the map before the machinery. Documentation comes first, low-signal release metadata comes last, and the complete route must reproduce the exact feature commit tree.",
            uncertainties: [],
        },
        virtualCommits: groups.map(({ matches, ...group }) => group),
    };
};

export const buildOverviewDemoManifest = (source) => buildManifest({
    source,
    definitions: overviewGroupDefinitions,
    title: "Overview: review the Virtual Commit implementation in human order",
    strategy: "Overview · docs-first, then dependency and risk order. Six broad steps reveal the architecture before implementation detail.",
    summary: "One real feature commit introduced Virtual Commits across 45 changed files; Overview presents the same frozen Diff as six architectural steps.",
});

export const buildDeepReviewDemoManifest = (source) => buildManifest({
    source,
    definitions: deepReviewGroupDefinitions,
    title: "Deep review: inspect the Virtual Commit implementation in human order",
    strategy: "Deep review · docs-first, then dependency and risk order. Fourteen focused steps keep each reviewer question narrow without relying on source line numbers.",
    summary: "The same feature commit becomes fourteen focused review steps, from its contract and public interface through core invariants, runtime behavior, tests, and release metadata.",
});

export const buildDemoManifest = buildOverviewDemoManifest;
