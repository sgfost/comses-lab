export interface User {
  id: string;
  username: string;
  displayName: string;
}
export type ProjectPermission = "read" | "write" | "admin";
export type ProjectKind = "model" | "library";
export interface Project {
  kind: ProjectKind;
  extractedFrom: { projectId: string; commit: string } | null;
  id: string;
  title: string;
  description: string;
  visibility: "public" | "private";
  ownerId: string;
  ownerName: string;
  sharedWithMe?: boolean;
  entrypoint: string;
  license: string;
  forgejoOwner: string;
  forgejoRepo: string;
  forgejoId: number;
  permission: ProjectPermission;
  metadataVersion: number;
  dataOrigins: string[];
  forkedFrom: { projectId: string; commit: string } | null;
}
export type TemplateId = "ant-trails" | "predator-prey" | "galaxy-encounter" | "wave-tank" | "commons" | "worker" | "python" | "marimo" | "netlogo" | "library-python" | "library-js";
export interface ProjectTemplate {
  kind: ProjectKind;
  id: TemplateId;
  title: string;
  description: string;
  entrypoint: string;
  license: string;
}
export interface CreateProjectRequest {
  requestId: string;
  templateId: TemplateId;
  title: string;
  visibility: "public" | "private";
  description?: string;
  netlogoFile?: { name: string; content: string };
}
export interface ForkProjectRequest {
  requestId: string;
  commit: string;
  title: string;
  visibility?: "public" | "private";
}
export interface CreateProjectResponse {
  project: Project;
  ref: "refs/heads/main";
  commit: string;
}
export type FileChange =
  | { operation: "create" | "update"; path: string; content: string }
  | { operation: "delete"; path: string };
export interface CommitRequest {
  ref: string;
  expectedCommit: string;
  message: string;
  changes: FileChange[];
}
export interface RestoreRequest {
  ref: string;
  expectedCommit: string;
  sourceCommit: string;
}
export interface CommitResponse {
  ref: string;
  commit: string;
}
export interface Draft {
  ref: string;
  baseCommit: string;
  version: number;
  changes: FileChange[];
  updatedAt: number;
  savingCommit: string | null;
}
export interface UpdateProjectRequest {
  expectedMetadataVersion: number;
  title?: string;
  description?: string;
  license?: string;
  entrypoint?: string;
  dataOrigins?: string[];
}
export interface SourceTree {
  commit: string;
  files: { path: string; size: number }[];
}
export type RefKind = "branch" | "tag";
export interface SourceRef {
  name: string;
  ref: string;
  commit: string;
}
export interface RefList {
  kind: RefKind;
  defaultBranch: string;
  refs: SourceRef[];
  page: number;
  limit: number;
  nextPage: number | null;
}
export interface SourceCommit {
  commit: string;
  parents: string[];
  message: string;
  author: { name: string; date: string };
}
export interface CommitHistory {
  commit: string;
  commits: SourceCommit[];
  page: number;
  limit: number;
  nextPage: number | null;
}
export interface CommitDiff {
  commit: string;
  base: string | null;
  patch: string;
}
export interface Launch {
  runtime?: "netlogo" | "marimo";
  standaloneUrl?: string;
  draft?: boolean;
  id: string;
  commit: string;
  url: string;
  expiresAt: number;
}
export interface LaunchStatus {
  id: string;
  state: "active";
  expiresAt: number;
}
export type MemberPermission = "read" | "write";
export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  permission: MemberPermission;
}
export interface Group {
  id: string;
  name: string;
  ownerId: string;
  permission: ProjectPermission;
  version: number;
}
export interface AccessPolicy {
  visibility: "public" | "private";
  groupId: string | null;
}
export interface GroupResponse {
  group: Group;
  members: GroupMember[];
  sync: { state: "ready" } | {
    state: "pending";
    operationId: string;
    desiredMembers: GroupMember[];
    blockedProjectIds: string[];
    unconfirmedProjectIds: string[];
    message: string;
  };
}
export interface UpdateGroupMembersRequest {
  requestId: string;
  expectedVersion: number;
  members: { userId: string; permission: MemberPermission }[];
}
export interface ProjectAccessResponse {
  projectId: string;
  version: number;
  effective: AccessPolicy & { mode: "normal" | "owner_read_only" };
  sync: { state: "ready" } | {
    state: "pending";
    operationId: string;
    desired: AccessPolicy;
    unconfirmedProjectIds: string[];
    message: string;
  };
}
export interface UpdateProjectAccessRequest extends AccessPolicy {
  requestId: string;
  expectedVersion: number;
  confirmPublic?: true;
}
export interface GrantProject {
  projectId: string;
  permission: MemberPermission;
}
export interface Grant {
  id: string;
  name: string;
  state: "active" | "revocation_pending" | "revoked";
  allowCreate: boolean;
  projects: GrantProject[];
}
export interface GitCredential {
  id: string;
  grantId: string;
  projectId: string;
  permission: MemberPermission;
  username: string;
  url: string;
  state: "issuing" | "active" | "issuance_unknown" | "revocation_pending" | "revoked";
  recovery: "none" | "operator_required";
}
export interface CreateGrantRequest {
  name: string;
  allowCreate?: boolean;
  projects: GrantProject[];
}
export interface CreateGrantResponse {
  grant: Grant;
  token: string;
}
export interface AgentLoginRequest {
  userCode: string;
  name: string;
  projects: GrantProject[];
  allowCreate: boolean;
  state: "pending" | "approved" | "denied" | "consumed";
  expiresAt: number;
}
export interface GrantResponse {
  grant: Grant;
  credentials: GitCredential[];
}
export interface CreateGitCredentialRequest {
  requestId: string;
  projectId: string;
  permission: MemberPermission;
}
export interface CredentialResponse {
  credential: GitCredential;
}
export interface CreateGitCredentialResponse extends CredentialResponse {
  token: string;
}
export interface ApiError {
  error: {
    code: string;
    message: string;
    ref?: string;
    expectedCommit?: string;
    currentCommit?: string | null;
    currentMetadataVersion?: number;
    currentVersion?: number;
    operationId?: string;
    credentialId?: string;
    credential?: GitCredential;
  };
}

export interface ExtractionRequest {
  requestId: string;
  commit: string;
  title: string;
  visibility: "public" | "private";
  paths: string[];
}
export interface LibraryFile { source: string; path: string; sha256: string }
export interface LibraryPin { projectId: string; commit: string; directory: string; files: LibraryFile[] }
export interface ProjectLibraries {
  commit: string;
  libraries: LibraryDependency[];
}
export interface InstallLibraryRequest {
  ref: string;
  expectedCommit: string;
  libraryId: string;
  commit: string;
  directory: string;
  paths: string[];
  message: string;
}
export interface RemoveLibraryRequest {
  ref: string;
  expectedCommit: string;
  directory: string;
  message: string;
}

export interface LibraryDependency extends LibraryPin {
  project: Project | null;
  modified: boolean;
  children: LibraryDependency[];
}
