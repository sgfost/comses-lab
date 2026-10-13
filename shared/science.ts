export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export interface Companion {
  entrypoint: string;
  recordPath: string;
  engineBundleId: string;
}

export interface CompanionExportRecord {
  formatVersion: 1;
  notebook: string;
  inputCommit: string;
  inputs: { path: string; sha256: string }[];
  artifacts: { path: string; size: number; sha256: string }[];
  exporter: { marimoVersion: string; pythonVersion: string };
  engineBundleId: string;
  refreshCommand: string;
}

export interface ProjectLaunchRequest {
  commit: string;
  companion?: true;
}

export interface ReleaseLaunchRequest {
  companion?: true;
}

export interface ResultDraft {
  title: string;
  inputs: JsonValue;
  seed: string | null;
  environment: { name: string; version: string }[];
  dependencies: { name: string; version: string; sourceCommit?: string }[];
  files: { path: string; encoding: "utf8" | "base64"; content: string }[];
}

export interface SaveResultRequest extends ResultDraft {
  requestId: string;
  sourceCommit: string;
  expectedResultCommit: string | null;
}

export interface ResultRecord {
  id: string;
  projectId: string;
  title: string;
  sourceCommit: string;
  resultCommit: string;
  ref: "refs/heads/lab-results";
  manifestPath: string;
  manifestSha256: string;
  submittedBy: { id: string; username: string };
  submission: "session-client" | "agent-client";
  createdAt: string;
  files: { path: string; size: number; sha256: string }[];
  provenance: Omit<ResultDraft, "title" | "files">;
}

export interface ResultResponse {
  result: ResultRecord;
}

export interface ResultList {
  ref: "refs/heads/lab-results";
  head: string | null;
  results: ResultRecord[];
  page: number;
  limit: number;
  nextPage: number | null;
}

export interface PublishReleaseRequest {
  requestId: string;
  sourceCommit: string;
  expectedMetadataVersion: number;
  label: string;
  resultIds: string[];
}

export interface FrozenMetadata {
  title: string;
  description: string;
  license: string;
  entrypoint: string;
  owner: { id: string; name: string };
  metadataVersion: number;
  dataOrigins: string[];
  companion: Companion | null;
}

export interface ReleaseRecord {
  id: string;
  projectId: string;
  label: string;
  sourceCommit: string;
  metadata: FrozenMetadata;
  results: ResultRecord[];
  publishedBy: string;
  publishedAt: string;
  manifestSha256: string;
  archiveSha256: string;
  archiveSize: number;
  pageUrl: string;
  downloadUrl: string;
}

export type PublicationResponse =
  | { state: "ready"; release: ReleaseRecord }
  | { state: "pending"; releaseId: string; message: string };

export interface ReleaseList {
  releases: ReleaseRecord[];
  page: number;
  limit: number;
  nextPage: number | null;
}

export interface ForkReleaseRequest {
  requestId: string;
  title: string;
  visibility?: "public" | "private";
}
