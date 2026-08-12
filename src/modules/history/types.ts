/** Current on-disk schema understood by the history journal. */
export const HISTORY_SCHEMA_VERSION = 1 as const;

/** Current storage layout version for the history journal. */
export const HISTORY_STORAGE_VERSION = 1 as const;

/** Version number embedded in every persisted history document. */
export type HistorySchemaVersion = typeof HISTORY_SCHEMA_VERSION;

/** Stable identifier for a history transaction. */
export type HistoryTransactionId = string;

/** Stable identifier for a Git worktree. */
export type HistoryWorktreeId = string;

/** Supported persisted transaction provenance values. */
export const HISTORY_SOURCES = ['gdx', 'git-hook', 'reflog'] as const;

/** Private ref namespace used to keep replay trees reachable while a manifest exists. */
export const HISTORY_SNAPSHOT_REF_PREFIX = 'refs/gdx/history/snapshots/' as const;

/** How a transaction entered the durable journal. */
export type HistorySource = (typeof HISTORY_SOURCES)[number];

/** Command provenance associated with a recorded Git operation. */
export interface HistoryCommandMetadata {
   command: string;
   argv: string[];
   cwd: string;
   startedAt: string;
   finishedAt: string;
   exitCode: number | null;
   invocationId?: string;
   parentTransactionId?: HistoryTransactionId;
}

/** Supported persisted undo capability values. */
export const HISTORY_CAPABILITIES = ['exact', 'conditional', 'inferred', 'audit-only'] as const;

/** Strength of the evidence and recipe available for undoing a transaction. */
export type HistoryCapability = (typeof HISTORY_CAPABILITIES)[number];

/** A content identity used to detect stale repository state. */
export interface HistoryFingerprint {
   algorithm: 'sha256' | 'git-oid';
   value: string;
}

/** A ref that did not exist at a transaction boundary. */
export interface HistoryMissingRef {
   kind: 'missing';
}

/** A direct ref containing an object ID. */
export interface HistoryOidRef {
   kind: 'oid';
   oid: string;
}

/** A symbolic ref, with its optionally resolved object ID. */
export interface HistorySymbolicRef {
   kind: 'symbolic';
   target: string;
   oid: string | null;
}

/** Complete persisted value of a ref, including absence and symbolic refs. */
export type HistoryRefState = HistoryMissingRef | HistoryOidRef | HistorySymbolicRef;

/** Creation, deletion, update, or retargeting of one Git ref. */
export interface HistoryRefChange {
   name: string;
   before: HistoryRefState;
   after: HistoryRefState;
}

/** Complete HEAD state, including unborn and detached repositories. */
export interface HistoryHeadState {
   value: HistoryRefState;
   unborn: boolean;
}

/** HEAD state before and after a transaction. */
export interface HistoryHeadChange {
   before: HistoryHeadState;
   after: HistoryHeadState;
}

/** A durable artifact stored alongside a transaction manifest. */
export interface HistoryArtifactReference {
   path: string;
   size: number;
   fingerprint: HistoryFingerprint;
}

/** Index identity at one transaction boundary. */
export interface HistoryIndexState {
   treeOid: string | null;
   entryCount: number;
   fingerprint: HistoryFingerprint;
}

/** An index restoration recipe represented by a Git tree. */
export interface HistoryIndexTreeRecipe {
   kind: 'tree';
   treeOid: string;
}

/** An index restoration recipe represented by one raw index blob. */
export interface HistoryIndexRawRecipe {
   kind: 'raw';
   blob: HistoryArtifactReference;
   checksum: string;
}

/** One content-addressed blob shared by an index restoration recipe. */
export interface HistoryIndexSharedBlob {
   oid: string;
   blob: HistoryArtifactReference;
}

/** An index restoration recipe assembled from shared content-addressed blobs. */
export interface HistoryIndexSharedBlobsRecipe {
   kind: 'shared-blobs';
   blobs: HistoryIndexSharedBlob[];
   checksum: string;
}

/** Supported durable recipes for reconstructing the index exactly. */
export type HistoryIndexRecipe =
   | HistoryIndexTreeRecipe
   | HistoryIndexRawRecipe
   | HistoryIndexSharedBlobsRecipe;

/** Index state transition and restoration recipes. */
export interface HistoryIndexChange {
   before: HistoryIndexState;
   after: HistoryIndexState;
   undo: HistoryIndexRecipe;
   redo?: HistoryIndexRecipe;
}

/** A complete tracked repository boundary used by history for replay-style operations. */
export interface HistorySnapshotState {
   head: HistoryHeadState;
   index: HistoryArtifactReference | null;
   /** Tree object representing the staged/index entries (ignores stat-cache churn). */
   indexTree: string;
   /** Normalized semantic index fingerprint, excluding filesystem stat-cache fields. */
   indexSemanticFingerprint: string;
   indexChecksum: string;
   /** Tree object representing tracked worktree content at this boundary. */
   worktreeTree: string;
}

/** Snapshot transition and the direct refs changed by the operation. */
export interface HistorySnapshotChange {
   before: HistorySnapshotState;
   after: HistorySnapshotState;
   refs: HistoryRefChange[];
}

/** Kind of filesystem entry captured by history. */
export type HistoryPathEntryKind = 'absent' | 'file' | 'directory' | 'symlink' | 'gitlink';

/** File state at one transaction boundary. */
export interface HistoryPathState {
   kind: HistoryPathEntryKind;
   mode: string | null;
   size: number | null;
   oid: string | null;
   fingerprint: HistoryFingerprint | null;
}

/** Why a path appears in a transaction manifest. */
export type HistoryPathChangeKind =
   | 'add'
   | 'modify'
   | 'delete'
   | 'rename'
   | 'copy'
   | 'type-change'
   | 'unmerged';

/** Lossless path identity plus a human-readable rendering and tracked state. */
export interface HistoryRawPath {
   bytesBase64: string;
   display: string;
   tracked: boolean;
}

/** Worktree/index transition for one repository-relative path. */
export interface HistoryPathChange {
   path: HistoryRawPath;
   previousPath?: HistoryRawPath;
   kind: HistoryPathChangeKind;
   before: HistoryPathState;
   after: HistoryPathState;
   staged: boolean;
   artifact?: HistoryArtifactReference;
}

/** Git's sequencer or repository-control operation at a boundary. */
export type HistoryControlKind =
   | 'none'
   | 'merge'
   | 'rebase'
   | 'cherry-pick'
   | 'revert'
   | 'bisect'
   | 'am';

/** State that controls an in-progress multi-step Git operation. */
export interface HistoryControlState {
   kind: HistoryControlKind;
   inProgress: boolean;
   headName: string | null;
   originalHead: string | null;
   step: number | null;
   totalSteps: number | null;
   fingerprint: HistoryFingerprint;
}

/** Control state transition and optional restoration artifacts. */
export interface HistoryControlChange {
   before: HistoryControlState;
   after: HistoryControlState;
   artifacts: HistoryArtifactReference[];
}

/** Fingerprints for all repository surfaces protected by stale-state checks. */
export interface HistoryRepositoryFingerprint {
   refs: HistoryFingerprint;
   head: HistoryFingerprint;
   index: HistoryFingerprint;
   paths: HistoryFingerprint;
   control: HistoryFingerprint;
   combined: HistoryFingerprint;
}

/** Repository fingerprints before and after a transaction. */
export interface HistoryFingerprints {
   before: HistoryRepositoryFingerprint;
   after: HistoryRepositoryFingerprint;
}

/** Minimal Git-native operation used to move between transaction boundaries. */
export type HistoryInverseRecipe =
   | { kind: 'head-soft'; before: HistoryHeadState; after: HistoryHeadState }
   | { kind: 'switch'; before: HistoryHeadState; after: HistoryHeadState }
   | { kind: 'refs'; changes: HistoryRefChange[] }
   | { kind: 'snapshot'; before: HistorySnapshotState; after: HistorySnapshotState; refs: HistoryRefChange[] }
   | {
        kind: 'raw-index';
        before: HistoryArtifactReference | null;
        after: HistoryArtifactReference | null;
        beforeChecksum: string;
        afterChecksum: string;
     };

/** Durable description of one reversible repository transaction. */
export interface HistoryTransactionManifest {
   schemaVersion: HistorySchemaVersion;
   id: HistoryTransactionId;
   worktreeId: HistoryWorktreeId;
   createdAt: string;
   source: HistorySource;
   command?: HistoryCommandMetadata;
   capability: HistoryCapability;
   refs: HistoryRefChange[];
   head?: HistoryHeadChange;
   index?: HistoryIndexChange;
   paths?: HistoryPathChange[];
   control?: HistoryControlChange;
   fingerprints: HistoryFingerprints;
   /** Action-specific best-effort inverse. Absent on audit/reflog records. */
   recipe?: HistoryInverseRecipe;
   undoUnavailableReason?: string;
}

/** Caller-supplied transaction data before storage assigns journal identity. */
export type HistoryTransactionInput = Omit<
   HistoryTransactionManifest,
   'schemaVersion' | 'id' | 'worktreeId' | 'createdAt'
> & {
   id?: HistoryTransactionId;
   createdAt?: string;
};

/** Stable identity and resolved directories for one Git worktree. */
export interface HistoryWorktreeIdentity {
   id: HistoryWorktreeId;
   root: string;
   gitDir: string;
   commonGitDir: string;
}

/** Worktree registration kept in repository-level history state. */
export interface HistoryWorktreeRegistration extends HistoryWorktreeIdentity {
   timelinePath: string;
   createdAt: string;
   updatedAt: string;
}

/** Repository-level schema and worktree registry. */
export interface HistoryRepositoryState {
   schemaVersion: HistorySchemaVersion;
   storageVersion: typeof HISTORY_STORAGE_VERSION;
   revision: number;
   createdAt: string;
   updatedAt: string;
   worktrees: Record<HistoryWorktreeId, HistoryWorktreeRegistration>;
}

/** Per-worktree transaction order and undo/redo cursor. */
export interface HistoryTimeline {
   schemaVersion: HistorySchemaVersion;
   worktreeId: HistoryWorktreeId;
   revision: number;
   createdAt: string;
   updatedAt: string;
   /** Oldest-to-newest transaction IDs. */
   entries: HistoryTransactionId[];
   /** Index of the next redo entry; entries before it are currently applied. */
   cursor: number;
}

/** Result of appending a transaction and enforcing retention. */
export interface HistoryRecordResult {
   manifest: HistoryTransactionManifest;
   timeline: HistoryTimeline;
   discardedRedoIds: HistoryTransactionId[];
   prunedIds: HistoryTransactionId[];
}

/** Which portion of a timeline a relative selector addresses. */
export type HistorySelectorScope = 'applied' | 'redo' | 'all';

/** A selector resolved to a stable transaction and timeline position. */
export interface HistoryTimelineSelection {
   id: HistoryTransactionId;
   index: number;
   relativeIndex: number;
   state: 'applied' | 'redo';
}

/** Metadata for a worktree's observer and durable spool sequence. */
export interface HistoryObserverMetadata {
   schemaVersion: HistorySchemaVersion;
   observerId: string;
   worktreeId: HistoryWorktreeId;
   installedAt: string;
   updatedAt: string;
   nextSequence: number;
   lastObservedAt: string | null;
   lastTransactionId: HistoryTransactionId | null;
}

/** Lifecycle event emitted by a shell observer. */
export type HistoryObserverEvent = 'command-start' | 'command-finish' | 'repository-change';

/** One durable observer event waiting to be reconciled. */
export interface HistoryObserverSpoolEntry {
   schemaVersion: HistorySchemaVersion;
   id: string;
   worktreeId: HistoryWorktreeId;
   sequence: number;
   createdAt: string;
   event: HistoryObserverEvent;
   source: HistorySource;
   command?: HistoryCommandMetadata;
   before: HistoryRepositoryFingerprint | null;
   after: HistoryRepositoryFingerprint | null;
   transactionId: HistoryTransactionId | null;
}

/** Caller-supplied observer event before storage assigns sequence and identity. */
export type HistoryObserverSpoolInput = Omit<
   HistoryObserverSpoolEntry,
   'schemaVersion' | 'id' | 'worktreeId' | 'sequence' | 'createdAt'
> & {
   id?: string;
   createdAt?: string;
};

/** Fully resolved repository-local history paths. */
export interface HistoryStoragePaths extends HistoryWorktreeIdentity {
   historyDir: string;
   stateFile: string;
   timelinesDir: string;
   timelineFile: string;
   transactionsDir: string;
   observersDir: string;
   observerMetadataFile: string;
   spoolDir: string;
   worktreeSpoolDir: string;
   locksDir: string;
   lockFile: string;
}
